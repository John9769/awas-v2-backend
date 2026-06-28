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
// Core of AWAS forensic integrity.
// Hash computed from RAW buffer BEFORE upload.
// Even if Cloudinary is compromised, hash remains valid.
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

// ─── HELPER: Generate invoice number ─────────────────────────────────────────
async function generateInvoiceNumber() {
    const year = new Date().getFullYear();
    const count = await prisma.invoice.count();
    return `AWAS-INV-${year}-${String(count + 1).padStart(4, '0')}`;
}

// ─── SUBMIT WRIT ──────────────────────────────────────────────────────────────
// Called ONLY when driver presses "Submit to Insurer" button.
// DRAFT is handled entirely on FE local storage — BE never sees drafts.
// Flow:
// 1. Receive video + images + audio (optional) + other party images (optional)
// 2. Compute SHA-256 from each buffer BEFORE upload
// 3. Upload all media to Cloudinary
// 4. Generate master logHash — SHA-256 of ALL evidence combined
// 5. Create AccidentLog with writStage: SUBMITTED
// 6. Create WritRebate record
// 7. Generate WRIT invoice (RM9.90) to insurer
// 8. Notify driver via email
exports.submitWrit = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;
        const {
            latitude,
            longitude,
            incidentDescription,
            roadCondition,
            weatherCondition,
            injuryStatus,
            claimType,
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
        if (!claimType || !['OWN_DAMAGE', 'THIRD_PARTY'].includes(claimType)) {
            return res.status(400).json({ error: 'Jenis tuntutan diperlukan (OWN_DAMAGE atau THIRD_PARTY).' });
        }

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate },
            include: { insurer: true }
        });

        if (!driver) return res.status(404).json({ error: 'Akaun pemandu tidak dijumpai.' });
        if (driver.status !== 'ACTIVE') return res.status(403).json({ error: 'Akaun tidak aktif.' });
        if (new Date() > new Date(driver.policyExpiry)) {
            return res.status(403).json({ error: 'Polisi insurans anda telah tamat. Sila hubungi syarikat insurans anda.' });
        }

        console.log(`AWAS V2: submitWrit called for ${vehiclePlate} — claimType: ${claimType}`);

        // ─── STEP 1: Compute video SHA-256 BEFORE upload ──────────────────────
        const videoBuffer = req.files['video'][0].buffer;
        const videoHash = computeSHA256FromBuffer(videoBuffer);
        console.log(`AWAS V2: Video SHA-256 — ${videoHash}`);

        // ─── STEP 2: Upload video to Cloudinary ───────────────────────────────
        const videoUpload = await uploadToCloudinary(videoBuffer, {
            resource_type: 'video',
            folder: `awas-v2/${vehiclePlate}/raw`,
            public_id: `raw_${Date.now()}`
        });
        const rawVideoUrl = videoUpload.secure_url;
        console.log(`AWAS V2: Video uploaded — ${rawVideoUrl}`);

        // ─── STEP 3: Process own vehicle images (max 5) ───────────────────────
        const imageUrls = [];
        const imageHashes = [];

        if (req.files['images'] && req.files['images'].length > 0) {
            const ownImages = req.files['images'].slice(0, 5);
            for (let i = 0; i < ownImages.length; i++) {
                const imgBuffer = ownImages[i].buffer;
                const imgHash = computeSHA256FromBuffer(imgBuffer);
                imageHashes.push(imgHash);
                console.log(`AWAS V2: Image ${i + 1} SHA-256 — ${imgHash}`);

                const imgUpload = await uploadToCloudinary(imgBuffer, {
                    resource_type: 'image',
                    folder: `awas-v2/${vehiclePlate}/images`,
                    public_id: `img_${Date.now()}_${i}`
                });
                imageUrls.push(imgUpload.secure_url);
            }
        }

        // ─── STEP 4: Process audio (optional) ────────────────────────────────
        let audioUrl = null;
        let audioHash = null;

        if (req.files['audio'] && req.files['audio'].length > 0) {
            const audioBuffer = req.files['audio'][0].buffer;
            audioHash = computeSHA256FromBuffer(audioBuffer);
            console.log(`AWAS V2: Audio SHA-256 — ${audioHash}`);

            const audioUpload = await uploadToCloudinary(audioBuffer, {
                resource_type: 'video',
                folder: `awas-v2/${vehiclePlate}/audio`,
                public_id: `audio_${Date.now()}`
            });
            audioUrl = audioUpload.secure_url;
            console.log(`AWAS V2: Audio uploaded — ${audioUrl}`);
        }

        // ─── STEP 5: Process other party images (max 2, optional) ────────────
        const otherVehicleImageUrls = [];
        const otherVehicleImageHashes = [];

        if (req.files['otherImages'] && req.files['otherImages'].length > 0) {
            const otherImages = req.files['otherImages'].slice(0, 2);
            for (let i = 0; i < otherImages.length; i++) {
                const imgBuffer = otherImages[i].buffer;
                const imgHash = computeSHA256FromBuffer(imgBuffer);
                otherVehicleImageHashes.push(imgHash);
                console.log(`AWAS V2: Other vehicle image ${i + 1} SHA-256 — ${imgHash}`);

                const imgUpload = await uploadToCloudinary(imgBuffer, {
                    resource_type: 'image',
                    folder: `awas-v2/${vehiclePlate}/other`,
                    public_id: `other_${Date.now()}_${i}`
                });
                otherVehicleImageUrls.push(imgUpload.secure_url);
            }
        }

        // ─── STEP 6: Generate master logHash ──────────────────────────────────
        // logHash = SHA-256 of ALL evidence combined
        // Any tampering with ANY file will break this seal
        const submittedAt = new Date().toISOString();
        const logContent = [
            vehiclePlate,
            videoHash,
            ...imageHashes,
            audioHash || '',
            ...otherVehicleImageHashes,
            parseFloat(latitude).toFixed(8),
            parseFloat(longitude).toFixed(8),
            submittedAt
        ].join('|');
        const logHash = crypto.createHash('sha256').update(logContent).digest('hex');
        console.log(`AWAS V2: Master logHash — ${logHash}`);

        // ─── STEP 7: Generate writ number ─────────────────────────────────────
        const writNumber = await generateWritNumber();

        // ─── STEP 8: Save to DB ───────────────────────────────────────────────
        const log = await prisma.accidentLog.create({
            data: {
                writNumber,
                logHash,
                vehiclePlate,
                writStage: 'SUBMITTED',
                submittedAt: new Date(submittedAt),
                claimType,
                videoUrl: rawVideoUrl,
                rawVideoUrl,
                videoHash,
                imageUrls,
                imageHashes,
                audioUrl,
                audioHash,
                otherVehicleImageUrls: otherVehicleImageUrls.length > 0 ? otherVehicleImageUrls : null,
                otherVehicleImageHashes: otherVehicleImageHashes.length > 0 ? otherVehicleImageHashes : null,
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                incidentDescription: incidentDescription || null,
                roadCondition: roadCondition || 'UNKNOWN',
                weatherCondition: weatherCondition || 'UNKNOWN',
                injuryStatus: injuryStatus || 'NONE',
                otherVehiclePlate: otherVehiclePlate || null,
                otherVehicleMakeModel: otherVehicleMakeModel || null,
                videoSealedAt: new Date(submittedAt)
            }
        });

        console.log(`AWAS V2: Writ SUBMITTED — ${writNumber} for ${vehiclePlate}`);

        // ─── STEP 9: Create WritRebate record ─────────────────────────────────
        // OWN_DAMAGE = 10% rebate on next renewal (PERCENTAGE)
        // THIRD_PARTY = RM30 flat rebate on next renewal (FLAT)
        const rebateType = claimType === 'OWN_DAMAGE' ? 'PERCENTAGE' : 'FLAT';
        const rebateValue = claimType === 'OWN_DAMAGE' ? 10.00 : 30.00;

        await prisma.writRebate.create({
            data: {
                insurerId: driver.insurerId,
                driverId: driver.id,
                accidentLogId: log.id,
                claimType,
                rebateType,
                rebateValue,
                isApplied: false
            }
        });

        console.log(`AWAS V2: WritRebate created — ${claimType} — ${rebateType} ${rebateValue}`);

        // ─── STEP 10: Generate WRIT invoice to insurer (RM9.90) ──────────────
        try {
            const invoiceNumber = await generateInvoiceNumber();
            const unitFee = parseFloat(driver.insurer.writFee);
            const now = new Date();

            await prisma.invoice.create({
                data: {
                    invoiceNumber,
                    insurerId: driver.insurerId,
                    invoiceType: 'WRIT',
                    periodStart: now,
                    periodEnd: now,
                    totalUnits: 1,
                    unitFee,
                    totalAmount: unitFee
                }
            });

            console.log(`AWAS V2: Writ invoice ${invoiceNumber} — RM${unitFee} billed to insurer ${driver.insurer.name}`);
        } catch (invoiceErr) {
            console.error('AWAS V2: Writ invoice generation fault:', invoiceErr);
            // Non-fatal — writ already sealed
        }

        // ─── STEP 11: Notify driver via email ─────────────────────────────────
        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: driver.email,
                subject: `[AWAS] Writ Disubmit — ${writNumber}`,
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                    <h2 style="color:#0f172a;">✅ Writ Forensik AWAS Disubmit</h2>
                    <p>Writ kemalangan anda telah berjaya disubmit kepada syarikat insurans anda.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Nombor Writ</td><td style="padding:8px;font-weight:800;color:#dc2626;">${writNumber}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Plat Kenderaan</td><td style="padding:8px;">${vehiclePlate}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Jenis Tuntutan</td><td style="padding:8px;">${claimType === 'OWN_DAMAGE' ? 'Kerosakan Sendiri' : 'Pihak Ketiga'}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Tarikh & Masa</td><td style="padding:8px;">${new Date(submittedAt).toLocaleString('ms-MY')}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">SHA-256 Video</td><td style="padding:8px;font-family:monospace;font-size:0.75rem;word-break:break-all;">${videoHash}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Tandatangan Master</td><td style="padding:8px;font-family:monospace;font-size:0.75rem;word-break:break-all;">${logHash}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Rebat Renewal</td><td style="padding:8px;font-weight:800;color:#16a34a;">${claimType === 'OWN_DAMAGE' ? '10% diskaun pada renewal seterusnya' : 'RM30 diskaun pada renewal seterusnya'}</td></tr>
                    </table>
                    <p style="color:#16a34a;font-weight:700;">Syarikat insurans anda telah dimaklumkan secara automatik.</p>
                    <p style="font-size:0.8rem;color:#64748b;">Simpan nombor writ ini untuk rujukan laporan polis dan tuntutan insurans.</p>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('AWAS V2: Writ email notification fault:', emailErr);
        }

        return res.status(201).json({
            message: 'Writ berjaya disubmit kepada insurans.',
            writNumber: log.writNumber,
            logHash: log.logHash,
            videoHash: log.videoHash,
            imageHashes: log.imageHashes,
            audioHash: log.audioHash,
            writStage: log.writStage,
            submittedAt: log.submittedAt,
            claimType: log.claimType,
            rebateType,
            rebateValue
        });

    } catch (error) {
        console.error('AWAS V2 submitWrit Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa mengemukakan writ. Sila cuba lagi.' });
    }
};

// ─── GET MY WRITS ─────────────────────────────────────────────────────────────
// Driver sees ALL their writs — DRAFT and SUBMITTED
// DRAFT writs are stored locally on FE — this only returns SUBMITTED from DB
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
                audioHash: true,
                latitude: true,
                longitude: true,
                roadCondition: true,
                weatherCondition: true,
                injuryStatus: true,
                incidentDescription: true,
                claimType: true,
                otherVehiclePlate: true,
                otherVehicleMakeModel: true,
                writStage: true,
                submittedAt: true,
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
// Slug format: AWAS-MY-2026-000001
// Stored format: AWAS/MY/2026/000001
exports.getWritByNumber = async (req, res) => {
    try {
        const { writNumber } = req.params;

        const parts = writNumber.split('-');
        let normalizedWritNumber;
        if (parts.length === 4) {
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
                },
                writRebate: true
            }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });

        return res.status(200).json(log);

    } catch (error) {
        console.error('AWAS V2 getWritByNumber Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};