const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { Resend } = require('resend');
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─── HELPER: Compute SHA-256 from buffer ─────────────────────────────────────
// This is the CORE of AWAS forensic integrity.
// Hash is computed from the RAW file buffer BEFORE upload.
// This means even if Cloudinary is compromised, the hash remains valid.
// The hash proves the file has not been modified since the moment of capture.
function computeSHA256FromBuffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ─── HELPER: Upload buffer to Cloudinary ─────────────────────────────────────
function uploadToCloudinary(buffer, options) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
            if (error) return reject(error);
            resolve(result);
        });
        stream.end(buffer);
    });
}

// ─── HELPER: Generate writ number ────────────────────────────────────────────
async function generateWritNumber() {
    const year = new Date().getFullYear();
    const count = await prisma.accidentLog.count();
    return `AWAS/MY/${year}/${String(count + 1).padStart(6, '0')}`;
}

// ─── VERIFY AND SEAL WRIT ─────────────────────────────────────────────────────
// Flow:
// 1. Receive video + images as multipart form (via multer middleware)
// 2. Compute SHA-256 from buffer — BEFORE upload (tamper-proof)
// 3. Upload to Cloudinary
// 4. Generate logHash — SHA-256 of all evidence combined
// 5. Create AccidentLog — sealed permanently
exports.verifyAndSeal = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;
        const {
            latitude,
            longitude,
            incidentDescription,
            roadCondition,
            weatherCondition,
            injuryStatus,
            otherVehiclePlate,
            otherVehicleMakeModel
        } = req.body;

        // Validate required fields
        if (!req.files || !req.files['video']) {
            return res.status(400).json({ error: 'Video diperlukan.' });
        }
        if (!latitude || !longitude) {
            return res.status(400).json({ error: 'Koordinat GPS diperlukan.' });
        }

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate }
        });

        if (!driver) {
            return res.status(404).json({ error: 'Akaun pemandu tidak dijumpai.' });
        }
        if (driver.status !== 'ACTIVE') {
            return res.status(403).json({ error: 'Akaun tidak aktif.' });
        }
        if (new Date() > new Date(driver.policyExpiry)) {
            return res.status(403).json({ error: 'Polisi insurans anda telah tamat. Sila hubungi syarikat insurans anda.' });
        }

        console.log(`AWAS V2: verifyAndSeal called for ${vehiclePlate}`);

        // ─── STEP 1: Compute video SHA-256 from buffer BEFORE upload ─────────
        const videoBuffer = req.files['video'][0].buffer;
        const videoHash = computeSHA256FromBuffer(videoBuffer);
        console.log(`AWAS V2: Video SHA-256 — ${videoHash}`);

        // ─── STEP 2: Upload video to Cloudinary ──────────────────────────────
        const videoUpload = await uploadToCloudinary(videoBuffer, {
            resource_type: 'video',
            folder: `awas-v2/${vehiclePlate}/raw`,
            public_id: `raw_${Date.now()}`
        });
        const rawVideoUrl = videoUpload.secure_url;
        console.log(`AWAS V2: Video uploaded — ${rawVideoUrl}`);

        // ─── STEP 3: Process images ───────────────────────────────────────────
        const imageUrls = [];
        const imageHashes = [];

        if (req.files['images'] && req.files['images'].length > 0) {
            for (let i = 0; i < req.files['images'].length; i++) {
                const imgBuffer = req.files['images'][i].buffer;

                // Compute SHA-256 from buffer BEFORE upload
                const imgHash = computeSHA256FromBuffer(imgBuffer);
                imageHashes.push(imgHash);
                console.log(`AWAS V2: Image ${i + 1} SHA-256 — ${imgHash}`);

                // Upload to Cloudinary
                const imgUpload = await uploadToCloudinary(imgBuffer, {
                    resource_type: 'image',
                    folder: `awas-v2/${vehiclePlate}/images`,
                    public_id: `img_${Date.now()}_${i}`
                });
                imageUrls.push(imgUpload.secure_url);
                console.log(`AWAS V2: Image ${i + 1} uploaded — ${imgUpload.secure_url}`);
            }
        }

        // ─── STEP 4: Generate logHash — master seal ───────────────────────────
        // logHash = SHA-256 of ALL evidence combined
        // This is the master fingerprint of the entire accident record
        // Any tampering with ANY file will change this hash
        const sealedAt = new Date().toISOString();
        const logContent = [
            vehiclePlate,
            videoHash,
            ...imageHashes,
            parseFloat(latitude).toFixed(8),
            parseFloat(longitude).toFixed(8),
            sealedAt
        ].join('|');
        const logHash = crypto.createHash('sha256').update(logContent).digest('hex');
        console.log(`AWAS V2: Master logHash — ${logHash}`);

        // ─── STEP 5: Generate writ number ────────────────────────────────────
        const writNumber = await generateWritNumber();

        // ─── STEP 6: Save to DB ───────────────────────────────────────────────
        const log = await prisma.accidentLog.create({
            data: {
                writNumber,
                logHash,
                vehiclePlate,
                videoUrl: rawVideoUrl,
                rawVideoUrl,
                videoHash,
                imageUrls,
                imageHashes,
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                incidentDescription: incidentDescription || null,
                roadCondition: roadCondition || 'UNKNOWN',
                weatherCondition: weatherCondition || 'UNKNOWN',
                injuryStatus: injuryStatus || 'NONE',
                otherVehiclePlate: otherVehiclePlate || null,
                otherVehicleMakeModel: otherVehicleMakeModel || null,
                writStatus: 'SEALED',
                videoSealedAt: new Date(sealedAt)
            }
        });

        console.log(`AWAS V2: Writ SEALED — ${writNumber} for ${vehiclePlate}`);

        // ─── STEP 7: Notify driver via email ─────────────────────────────────
        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: driver.email,
                subject: `[AWAS] Writ Dimeterai — ${writNumber}`,
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                    <h2 style="color:#0f172a;">✅ Writ Forensik AWAS Dimeterai</h2>
                    <p>Writ kemalangan anda telah berjaya dimeterai secara digital.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Nombor Writ</td><td style="padding:8px;font-weight:800;color:#dc2626;">${writNumber}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Plat Kenderaan</td><td style="padding:8px;">${vehiclePlate}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Tarikh & Masa</td><td style="padding:8px;">${new Date(sealedAt).toLocaleString('ms-MY')}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">SHA-256 Video</td><td style="padding:8px;font-family:monospace;font-size:0.75rem;word-break:break-all;">${videoHash}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Tandatangan Master</td><td style="padding:8px;font-family:monospace;font-size:0.75rem;word-break:break-all;">${logHash}</td></tr>
                    </table>
                    <p style="font-size:0.8rem;color:#64748b;">Simpan nombor writ ini untuk rujukan laporan polis dan tuntutan insurans.</p>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('AWAS V2: Writ email notification fault:', emailErr);
            // Non-fatal — writ already sealed in DB
        }

        return res.status(201).json({
            message: 'Writ berjaya dimeterai.',
            writNumber: log.writNumber,
            logHash: log.logHash,
            videoHash: log.videoHash,
            imageHashes: log.imageHashes,
            writStatus: log.writStatus,
            videoSealedAt: log.videoSealedAt,
            createdAt: log.createdAt
        });

    } catch (error) {
        console.error('AWAS V2 verifyAndSeal Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa memeterai writ. Sila cuba lagi.' });
    }
};

// ─── GET MY WRITS ─────────────────────────────────────────────────────────────
exports.getMyWrits = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;

        const writs = await prisma.accidentLog.findMany({
            where: { vehiclePlate },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                writNumber: true,
                logHash: true,
                videoHash: true,
                imageHashes: true,
                latitude: true,
                longitude: true,
                roadCondition: true,
                weatherCondition: true,
                injuryStatus: true,
                incidentDescription: true,
                otherVehiclePlate: true,
                otherVehicleMakeModel: true,
                writStatus: true,
                videoSealedAt: true,
                createdAt: true
            }
        });

        return res.status(200).json({ count: writs.length, writs });

    } catch (error) {
        console.error('AWAS V2 getMyWrits Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET WRIT BY NUMBER ───────────────────────────────────────────────────────
// Public — writ number in URL path
// Slug format: AWAS-MY-2026-000001
// Stored format: AWAS/MY/2026/000001
exports.getWritByNumber = async (req, res) => {
    try {
        const { writNumber } = req.params;

        // Normalize slug to stored format
        // AWAS-MY-2026-000001 → AWAS/MY/2026/000001
        const parts = writNumber.split('-');
        let normalizedWritNumber;

        if (parts.length === 4) {
            // AWAS-MY-2026-000001
            normalizedWritNumber = `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`;
        } else {
            normalizedWritNumber = writNumber;
        }

        const log = await prisma.accidentLog.findUnique({
            where: { writNumber: normalizedWritNumber },
            include: {
                driver: {
                    select: {
                        vehiclePlate: true,
                        vehicleMakeModel: true,
                        vehicleType: true,
                        insurer: { select: { name: true } }
                    }
                }
            }
        });

        if (!log) {
            return res.status(404).json({ error: 'Writ tidak dijumpai.' });
        }

        return res.status(200).json(log);

    } catch (error) {
        console.error('AWAS V2 getWritByNumber Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};