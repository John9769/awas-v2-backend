const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─── HELPER: Compute SHA-256 from buffer ─────────────────────────────────────
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

// ─── HELPER: Fetch image from URL as base64 ──────────────────────────────────
async function fetchImageAsBase64(url) {
    const https = require('https');
    const http = require('http');
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve(buffer.toString('base64'));
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

// ─── HELPER: Get pricing from DB ─────────────────────────────────────────────
async function getPricing(key, vehicleType) {
    const config = await prisma.pricingConfig.findUnique({
        where: { key_vehicleType: { key, vehicleType } }
    });
    if (!config) throw new Error(`PricingConfig missing: ${key} / ${vehicleType}`);
    return parseFloat(config.amount);
}

// ─── INTERNAL: Run AI Assessment (SILENT — never expose to policyholder) ─────
// Fires automatically after police report upload.
// Sends all evidence images + police report to Claude Vision.
// Result stored in AiAssessment table.
// Full package (writ + AI assessment) pushed to insurer HOC portal.
async function runAiAssessment(accidentLogId) {
    let assessment;
    try {
        // Create PENDING record immediately
        assessment = await prisma.aiAssessment.create({
            data: {
                accidentLogId,
                status: 'PENDING'
            }
        });

        const log = await prisma.accidentLog.findUnique({
            where: { id: accidentLogId },
            include: {
                driver: {
                    select: {
                        vehiclePlate: true,
                        vehicleMakeModel: true,
                        vehicleType: true,
                        insurer: { select: { id: true, name: true, email: true } }
                    }
                }
            }
        });

        if (!log) throw new Error(`AccidentLog ${accidentLogId} not found`);

        // Collect all image URLs for Claude Vision
        const imageUrls = [];

        // Own vehicle images
        if (log.imageUrls && Array.isArray(log.imageUrls)) {
            for (const url of log.imageUrls) {
                imageUrls.push(url);
            }
        }

        // Other vehicle images
        if (log.otherVehicleImageUrls && Array.isArray(log.otherVehicleImageUrls)) {
            for (const url of log.otherVehicleImageUrls) {
                imageUrls.push(url);
            }
        }

        // Police report image
        if (log.policeReportUrl) {
            imageUrls.push(log.policeReportUrl);
        }

        if (imageUrls.length === 0) {
            throw new Error('No images available for AI assessment');
        }

        // Build Claude Vision message — all images in ONE call
        const messageContent = [];

        for (const url of imageUrls) {
            try {
                const base64 = await fetchImageAsBase64(url);
                // Detect media type from URL
                let mediaType = 'image/jpeg';
                if (url.includes('.png')) mediaType = 'image/png';
                else if (url.includes('.webp')) mediaType = 'image/webp';

                messageContent.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: mediaType,
                        data: base64
                    }
                });
            } catch (imgErr) {
                console.error(`AWAS V3 AI: Failed to fetch image ${url}:`, imgErr.message);
                // Skip failed image — continue with rest
            }
        }

        if (messageContent.length === 0) {
            throw new Error('All image fetches failed');
        }

        // Add assessment prompt
        messageContent.push({
            type: 'text',
            text: `You are an expert Malaysian motor vehicle damage assessor. Analyse these accident photos and provide a detailed repair cost estimate.

Vehicle: ${log.driver.vehicleMakeModel} (${log.driver.vehiclePlate})
Vehicle Type: ${log.driver.vehicleType}
Claim Type: ${log.claimType}
Road Condition: ${log.roadCondition}
Weather: ${log.weatherCondition}
Injury Status: ${log.injuryStatus}

Instructions:
1. Identify ALL visibly damaged parts across ALL images provided. Do not duplicate parts.
2. Estimate repair/replacement cost for each part in Malaysian Ringgit (MYR) based on current Malaysian workshop rates.
3. Consolidate parts seen from multiple angles — list each part ONCE only.
4. Be conservative and realistic. Use genuine parts pricing for Malaysian market.

Respond ONLY in this exact JSON format, no preamble, no markdown:
{
  "parts": [
    {
      "part": "Part name in English",
      "condition": "DAMAGED / SEVERELY_DAMAGED / SCRATCHED / DENTED",
      "action": "REPAIR / REPLACE",
      "estimatedCostMYR": 0
    }
  ],
  "totalEstimatedCostMYR": 0,
  "overallSeverity": "MINOR / MODERATE / SEVERE",
  "confidenceLevel": "LOW / MEDIUM / HIGH",
  "assessorNotes": "Brief notes on assessment in English",
  "disclaimer": "AI-generated estimate based on current Malaysian market rates. Final amount subject to insurer approval."
}`
        });

        console.log(`AWAS V3 AI: Sending ${messageContent.length - 1} images to Claude Vision for log ${accidentLogId}`);

        const response = await anthropic.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 2000,
            messages: [{ role: 'user', content: messageContent }]
        });

        const rawText = response.content[0].text.trim();

        // Parse JSON response
        let assessmentData;
        try {
            const clean = rawText.replace(/```json|```/g, '').trim();
            assessmentData = JSON.parse(clean);
        } catch (parseErr) {
            throw new Error(`Claude Vision response parse failed: ${rawText.substring(0, 200)}`);
        }

        // Update AiAssessment to COMPLETED
        await prisma.aiAssessment.update({
            where: { id: assessment.id },
            data: {
                status: 'COMPLETED',
                assessmentJson: assessmentData,
                totalEstimatedCost: assessmentData.totalEstimatedCostMYR || 0,
                overallSeverity: assessmentData.overallSeverity || 'UNKNOWN',
                confidenceLevel: assessmentData.confidenceLevel || 'LOW',
                sentToInsurerAt: new Date()
            }
        });

        // Create CashSettlement record (PENDING — awaiting HOC offer)
        const existingSettlement = await prisma.cashSettlement.findUnique({
            where: { accidentLogId }
        });

        if (!existingSettlement) {
            await prisma.cashSettlement.create({
                data: {
                    accidentLogId,
                    insurerId: log.driver.insurer.id,
                    status: 'PENDING'
                }
            });
        }

        // Notify insurer HOC via email — full package ready for review
        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: log.driver.insurer.email,
                subject: `[AWAS] Writ Baru + AI Assessment Sedia — ${log.writNumber}`,
                html: `
                    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
                    <h2 style="color:#0f172a;">🔍 Writ + AI Assessment Sedia untuk Semakan</h2>
                    <p>Writ kemalangan berikut telah lengkap dengan laporan polis dan AI assessment. Sedia untuk keputusan penyelesaian.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Nombor Writ</td><td style="padding:8px;font-weight:800;color:#dc2626;">${log.writNumber}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Kenderaan</td><td style="padding:8px;">${log.driver.vehicleMakeModel} (${log.driver.vehiclePlate})</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Jenis Tuntutan</td><td style="padding:8px;">${log.claimType}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Anggaran Kos Kerosakan</td><td style="padding:8px;font-weight:800;color:#dc2626;">RM ${assessmentData.totalEstimatedCostMYR?.toFixed(2)}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Tahap Kerosakan</td><td style="padding:8px;">${assessmentData.overallSeverity}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Keyakinan AI</td><td style="padding:8px;">${assessmentData.confidenceLevel}</td></tr>
                    </table>
                    <p style="font-size:0.8rem;color:#94a3b8;font-style:italic;">${assessmentData.disclaimer}</p>
                    <div style="margin:24px 0;">
                        <a href="${process.env.FE_URL}/insurer/settlements" style="background:#0f1623;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Buka Portal HOC</a>
                    </div>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('AWAS V3 AI: HOC notification email fault:', emailErr);
        }

        console.log(`AWAS V3 AI: Assessment COMPLETED for log ${accidentLogId} — RM${assessmentData.totalEstimatedCostMYR} / ${assessmentData.overallSeverity}`);
        return assessment;

    } catch (error) {
        console.error(`AWAS V3 AI: Assessment FAILED for log ${accidentLogId}:`, error.message);

        // Update to FAILED — do not crash the police report upload
        if (assessment) {
            await prisma.aiAssessment.update({
                where: { id: assessment.id },
                data: {
                    status: 'FAILED',
                    failureReason: error.message
                }
            }).catch(e => console.error('AWAS V3 AI: Failed to update FAILED status:', e));
        }
    }
}

// ─── SUBMIT WRIT ──────────────────────────────────────────────────────────────
// V3: writ fee now read from PricingConfig by vehicleType
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

        console.log(`AWAS V3: submitWrit called for ${vehiclePlate} — claimType: ${claimType}`);

        // ─── Video ────────────────────────────────────────────────────────────
        const videoBuffer = req.files['video'][0].buffer;
        const videoHash = computeSHA256FromBuffer(videoBuffer);

        const videoUpload = await uploadToCloudinary(videoBuffer, {
            resource_type: 'video',
            folder: `awas-v3/${vehiclePlate}/raw`,
            public_id: `raw_${Date.now()}`
        });
        const rawVideoUrl = videoUpload.secure_url;

        // ─── Own vehicle images ───────────────────────────────────────────────
        const imageUrls = [];
        const imageHashes = [];

        if (req.files['images'] && req.files['images'].length > 0) {
            const ownImages = req.files['images'].slice(0, 5);
            for (let i = 0; i < ownImages.length; i++) {
                const imgBuffer = ownImages[i].buffer;
                imageHashes.push(computeSHA256FromBuffer(imgBuffer));
                const imgUpload = await uploadToCloudinary(imgBuffer, {
                    resource_type: 'image',
                    folder: `awas-v3/${vehiclePlate}/images`,
                    public_id: `img_${Date.now()}_${i}`
                });
                imageUrls.push(imgUpload.secure_url);
            }
        }

        // ─── Audio ────────────────────────────────────────────────────────────
        let audioUrl = null;
        let audioHash = null;

        if (req.files['audio'] && req.files['audio'].length > 0) {
            const audioBuffer = req.files['audio'][0].buffer;
            audioHash = computeSHA256FromBuffer(audioBuffer);
            const audioUpload = await uploadToCloudinary(audioBuffer, {
                resource_type: 'video',
                folder: `awas-v3/${vehiclePlate}/audio`,
                public_id: `audio_${Date.now()}`
            });
            audioUrl = audioUpload.secure_url;
        }

        // ─── Other vehicle images ─────────────────────────────────────────────
        const otherVehicleImageUrls = [];
        const otherVehicleImageHashes = [];

        if (req.files['otherImages'] && req.files['otherImages'].length > 0) {
            const otherImages = req.files['otherImages'].slice(0, 2);
            for (let i = 0; i < otherImages.length; i++) {
                const imgBuffer = otherImages[i].buffer;
                otherVehicleImageHashes.push(computeSHA256FromBuffer(imgBuffer));
                const imgUpload = await uploadToCloudinary(imgBuffer, {
                    resource_type: 'image',
                    folder: `awas-v3/${vehiclePlate}/other`,
                    public_id: `other_${Date.now()}_${i}`
                });
                otherVehicleImageUrls.push(imgUpload.secure_url);
            }
        }

        // ─── Master logHash ───────────────────────────────────────────────────
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

        const writNumber = await generateWritNumber();

        // ─── Save AccidentLog ─────────────────────────────────────────────────
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

        console.log(`AWAS V3: Writ SUBMITTED — ${writNumber} for ${vehiclePlate}`);

        // ─── WritRebate ───────────────────────────────────────────────────────
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

        // ─── WRIT invoice — read fee from PricingConfig ───────────────────────
        try {
            const invoiceNumber = await generateInvoiceNumber();
            const unitFee = await getPricing('WRIT_FEE', driver.vehicleType);
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

            console.log(`AWAS V3: Writ invoice ${invoiceNumber} — RM${unitFee} billed to insurer`);
        } catch (invoiceErr) {
            console.error('AWAS V3: Writ invoice generation fault:', invoiceErr);
        }

        // ─── Notify driver ────────────────────────────────────────────────────
        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: driver.email,
                subject: `[AWAS] Writ Disubmit — ${writNumber}`,
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                    <h2 style="color:#0f172a;">✅ Writ Forensik AWAS Disubmit</h2>
                    <p>Writ kemalangan anda telah berjaya disubmit.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Nombor Writ</td><td style="padding:8px;font-weight:800;color:#dc2626;">${writNumber}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Plat Kenderaan</td><td style="padding:8px;">${vehiclePlate}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Jenis Tuntutan</td><td style="padding:8px;">${claimType === 'OWN_DAMAGE' ? 'Kerosakan Sendiri' : 'Pihak Ketiga'}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Tandatangan Master</td><td style="padding:8px;font-family:monospace;font-size:0.75rem;word-break:break-all;">${logHash}</td></tr>
                    </table>
                    <p style="color:#f59e0b;font-weight:700;">⚠️ Langkah seterusnya: Sila upload laporan polis dalam masa 24 jam untuk meneruskan tuntutan.</p>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('AWAS V3: Writ email fault:', emailErr);
        }

        return res.status(201).json({
            message: 'Writ berjaya disubmit. Sila upload laporan polis untuk meneruskan tuntutan.',
            writNumber: log.writNumber,
            logHash: log.logHash,
            videoHash: log.videoHash,
            writStage: log.writStage,
            submittedAt: log.submittedAt,
            claimType: log.claimType,
            nextStep: 'UPLOAD_POLICE_REPORT'
        });

    } catch (error) {
        console.error('AWAS V3 submitWrit Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa mengemukakan writ. Sila cuba lagi.' });
    }
};

// ─── UPLOAD POLICE REPORT ─────────────────────────────────────────────────────
// V3 NEW. Driver uploads police report after writ submission.
// MANDATORY before any claim proceeds.
// After successful upload → triggers runAiAssessment() SILENTLY (fire-and-forget).
// Driver is NOT informed AI assessment is running.
// Response to driver is immediate — AI runs in background.
exports.uploadPoliceReport = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;
        const { writNumber, policeReportNumber } = req.body;

        if (!writNumber) {
            return res.status(400).json({ error: 'Nombor writ diperlukan.' });
        }
        if (!policeReportNumber) {
            return res.status(400).json({ error: 'Nombor laporan polis diperlukan.' });
        }
        if (!req.files || !req.files['policeReport'] || !req.files['policeReport'][0]) {
            return res.status(400).json({ error: 'Fail laporan polis diperlukan.' });
        }

        // Normalize writ number
        const parts = writNumber.split('-');
        const normalized = parts.length === 4
            ? `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`
            : writNumber;

        const log = await prisma.accidentLog.findUnique({
            where: { writNumber: normalized },
            include: {
                driver: { select: { vehiclePlate: true, insurerId: true } }
            }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });
        if (log.driver.vehiclePlate !== vehiclePlate) return res.status(403).json({ error: 'Akses ditolak.' });
        if (log.writStage !== 'SUBMITTED') return res.status(400).json({ error: 'Writ belum disubmit.' });
        if (log.policeReportUrl) return res.status(409).json({ error: 'Laporan polis sudah diupload untuk writ ini.' });

        // Upload police report to Cloudinary
        const reportBuffer = req.files['policeReport'][0].buffer;
        const reportUpload = await uploadToCloudinary(reportBuffer, {
            resource_type: 'image',
            folder: `awas-v3/${vehiclePlate}/police-reports`,
            public_id: `police_${Date.now()}`
        });

        const now = new Date();

        // Save to AccidentLog
        await prisma.accidentLog.update({
            where: { id: log.id },
            data: {
                policeReportUrl: reportUpload.secure_url,
                policeReportNumber: policeReportNumber.toUpperCase().trim(),
                policeReportUploadedAt: now
            }
        });

        console.log(`AWAS V3: Police report uploaded for writ ${normalized} — Report No: ${policeReportNumber}`);

        // ─── FIRE AI ASSESSMENT SILENTLY ──────────────────────────────────────
        // Do NOT await — response goes back to driver immediately.
        // AI runs in background. Driver never sees this happening.
        setImmediate(() => {
            runAiAssessment(log.id).catch(err => {
                console.error(`AWAS V3: Silent AI assessment fault for log ${log.id}:`, err);
            });
        });

        return res.status(200).json({
            message: 'Laporan polis berjaya diupload. Tuntutan anda sedang diproses oleh syarikat insurans.',
            writNumber: normalized,
            policeReportNumber: policeReportNumber.toUpperCase().trim(),
            uploadedAt: now
        });

    } catch (error) {
        console.error('AWAS V3 uploadPoliceReport Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa mengupload laporan polis.' });
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
                policeReportNumber: true,
                policeReportUploadedAt: true,
                createdAt: true,
                cashSettlement: {
                    select: {
                        status: true,
                        offeredAmount: true,
                        offeredAt: true,
                        offerExpiresAt: true
                    }
                }
            }
        });

        return res.status(200).json({ count: writs.length, writs });

    } catch (error) {
        console.error('AWAS V3 getMyWrits Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET WRIT BY NUMBER ───────────────────────────────────────────────────────
exports.getWritByNumber = async (req, res) => {
    try {
        const { writNumber } = req.params;

        const parts = writNumber.split('-');
        const normalized = parts.length === 4
            ? `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`
            : writNumber;

        const log = await prisma.accidentLog.findUnique({
            where: { writNumber: normalized },
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
                // NOTE: aiAssessment and cashSettlement deliberately excluded here
                // This is the public-facing endpoint — policyholder must NOT see AI data
            }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });

        return res.status(200).json(log);

    } catch (error) {
        console.error('AWAS V3 getWritByNumber Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};