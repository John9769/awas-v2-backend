const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const Anthropic = require('@anthropic-ai/sdk');
const prisma = new PrismaClient();
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

// ─── HELPER: build a labeled image block for Claude Vision ───────────────────
// FIX from audit: previously every image (own vehicle, other vehicle, police
// report) was pushed into one flat array with no label, so Claude had no
// signal distinguishing "photo to grade" from "document to verify". This is
// what let the mismatched Kelisa test slip through as a confident RM82,850
// estimate. Every image now gets an inline text label immediately before it.
async function buildLabeledImageBlock(url, label) {
    const base64 = await fetchImageAsBase64(url);
    let mediaType = 'image/jpeg';
    if (url.includes('.png')) mediaType = 'image/png';
    else if (url.includes('.webp')) mediaType = 'image/webp';

    return [
        { type: 'text', text: label },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
    ];
}

// ─── INTERNAL: Run AI Assessment (SILENT — never expose to policyholder) ─────
// Fires automatically after police report upload. Can also be re-triggered
// manually via retryAssessment() below.
// FIX: images are now labeled per-type so Claude can cross-check the
// declared vehicle and the police report against what it actually sees,
// instead of guessing from an unlabeled flat array.
// FIX: no email notification on completion or failure — HOC/Executive/
// Officer see everything live in the portal instead (confirmed today —
// nobody reads insurer inbox emails fast enough for a claim workflow).
async function runAiAssessment(accidentLogId) {
    let assessment = await prisma.aiAssessment.findUnique({ where: { accidentLogId } });

    try {
        if (!assessment) {
            assessment = await prisma.aiAssessment.create({
                data: { accidentLogId, status: 'PENDING' }
            });
        } else {
            assessment = await prisma.aiAssessment.update({
                where: { accidentLogId },
                data: { status: 'PENDING', failureReason: null }
            });
        }

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

        // ─── Build labeled message content ───────────────────────────────────
        const messageContent = [];
        let imageCount = 0;

        if (log.imageUrls && Array.isArray(log.imageUrls)) {
            for (const url of log.imageUrls) {
                try {
                    imageCount++;
                    const block = await buildLabeledImageBlock(
                        url,
                        `Own vehicle damage photo ${imageCount} — declared vehicle: ${log.driver.vehicleMakeModel} (${log.driver.vehiclePlate}). Assess damage AND verify this photo actually shows a vehicle matching the declared make/model.`
                    );
                    messageContent.push(...block);
                } catch (imgErr) {
                    console.error(`AWAS V3 AI: Failed to fetch own vehicle image ${url}:`, imgErr.message);
                }
            }
        }

        if (log.otherVehicleImageUrls && Array.isArray(log.otherVehicleImageUrls)) {
            let otherCount = 0;
            for (const url of log.otherVehicleImageUrls) {
                try {
                    otherCount++;
                    const block = await buildLabeledImageBlock(
                        url,
                        `Other party's vehicle photo ${otherCount} — declared: ${log.otherVehicleMakeModel || 'not specified'} (${log.otherVehiclePlate || 'not specified'}). For context only, not part of this policyholder's repair estimate.`
                    );
                    messageContent.push(...block);
                } catch (imgErr) {
                    console.error(`AWAS V3 AI: Failed to fetch other vehicle image ${url}:`, imgErr.message);
                }
            }
        }

        if (log.policeReportUrl) {
            try {
                const block = await buildLabeledImageBlock(
                    log.policeReportUrl,
                    `Police report document — READ this document. Extract the vehicle plate number(s) and incident narrative mentioned in it. This is a document to verify, NOT a damage photo to grade.`
                );
                messageContent.push(...block);
            } catch (imgErr) {
                console.error(`AWAS V3 AI: Failed to fetch police report ${log.policeReportUrl}:`, imgErr.message);
            }
        }

        if (imageCount === 0) {
            throw new Error('No own-vehicle images available for AI assessment');
        }

        messageContent.push({
            type: 'text',
            text: `You are an expert Malaysian motor vehicle damage assessor AND a fraud verification checkpoint.

Declared claim details:
- Vehicle: ${log.driver.vehicleMakeModel} (${log.driver.vehiclePlate})
- Vehicle Type: ${log.driver.vehicleType}
- Claim Type: ${log.claimType}
- Road Condition: ${log.roadCondition}
- Weather: ${log.weatherCondition}
- Injury Status: ${log.injuryStatus}
- Incident description (from driver): ${log.incidentDescription || 'not provided'}
- Police report number (declared by driver): ${log.policeReportNumber || 'not provided'}

You have been given: own-vehicle damage photo(s), possibly other-party vehicle photo(s), and a police report document.

STEP 1 — VERIFICATION (do this first, before estimating cost):
1. Does the vehicle shown in the own-vehicle damage photo(s) visually match the declared make/model (${log.driver.vehicleMakeModel})? Set vehicleMatchVerified true/false.
2. Does the police report document's content (plate number, incident narrative) correspond to this claim's declared vehicle and incident description? Set policeReportMatchVerified true/false.
3. If EITHER check fails, or the police report describes a clearly different incident/vehicle than what's declared, set fraudFlagged true and explain why in fraudReason. If both checks pass, fraudFlagged should be false and fraudReason null.

STEP 2 — DAMAGE ASSESSMENT (always do this regardless of Step 1 outcome — HOC needs to see the estimate either way):
1. Identify ALL visibly damaged parts across the own-vehicle photos. Do not duplicate parts.
2. Estimate repair/replacement cost for each part in Malaysian Ringgit (MYR) based on current Malaysian workshop rates.
3. Consolidate parts seen from multiple angles — list each part ONCE only.
4. Be conservative and realistic. Use genuine parts pricing for Malaysian market.

Respond ONLY in this exact JSON format, no preamble, no markdown:
{
  "vehicleMatchVerified": true,
  "policeReportMatchVerified": true,
  "fraudFlagged": false,
  "fraudReason": null,
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

        console.log(`AWAS V3 AI: Sending ${imageCount + (log.otherVehicleImageUrls?.length || 0) + (log.policeReportUrl ? 1 : 0)} labeled images to Claude Vision for log ${accidentLogId}`);

        const response = await anthropic.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 2000,
            messages: [{ role: 'user', content: messageContent }]
        });

        const rawText = response.content[0].text.trim();

        let assessmentData;
        try {
            const clean = rawText.replace(/```json|```/g, '').trim();
            assessmentData = JSON.parse(clean);
        } catch (parseErr) {
            throw new Error(`Claude Vision response parse failed: ${rawText.substring(0, 200)}`);
        }

        const fraudFlagged = assessmentData.fraudFlagged === true;

        await prisma.aiAssessment.update({
            where: { id: assessment.id },
            data: {
                status: 'COMPLETED',
                assessmentJson: assessmentData,
                totalEstimatedCost: assessmentData.totalEstimatedCostMYR || 0,
                overallSeverity: assessmentData.overallSeverity || 'UNKNOWN',
                confidenceLevel: assessmentData.confidenceLevel || 'LOW',
                vehicleMatchVerified: assessmentData.vehicleMatchVerified ?? null,
                policeReportMatchVerified: assessmentData.policeReportMatchVerified ?? null,
                fraudFlagged,
                fraudReason: assessmentData.fraudReason || null,
                sentToInsurerAt: new Date()
            }
        });

        // WritRebate only becomes eligible if the claim passed fraud checks.
        // Previously this fired unconditionally at submission — now it's
        // gated on a genuinely verified, non-fraud-flagged assessment.
        await prisma.writRebate.updateMany({
            where: { accidentLogId },
            data: { isEligible: !fraudFlagged }
        });

        // Create CashSettlement PENDING record — HOC decides later whether
        // it's actually eligible for a cash offer based on SettlementFeeTier
        // (checked at offer-time in insurerController, not here).
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

        console.log(`AWAS V3 AI: Assessment COMPLETED for log ${accidentLogId} — RM${assessmentData.totalEstimatedCostMYR} / ${assessmentData.overallSeverity} / fraudFlagged=${fraudFlagged}`);
        return assessment;

    } catch (error) {
        console.error(`AWAS V3 AI: Assessment FAILED for log ${accidentLogId}:`, error.message);

        if (assessment) {
            await prisma.aiAssessment.update({
                where: { id: assessment.id },
                data: {
                    status: 'FAILED',
                    failureReason: error.message
                }
            }).catch(e => console.error('AWAS V3 AI: Failed to update FAILED status:', e));
        }
        throw error;
    }
}

// ─── SUBMIT WRIT ──────────────────────────────────────────────────────────────
// CHANGED: writ fee is NO LONGER billed here. It bills at police report
// upload instead (see uploadPoliceReport below) — confirmed today, since
// billing at submission meant insurers could be charged for writs that are
// later abandoned before a police report ever gets uploaded.
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

        const videoBuffer = req.files['video'][0].buffer;
        const videoHash = computeSHA256FromBuffer(videoBuffer);

        const videoUpload = await uploadToCloudinary(videoBuffer, {
            resource_type: 'video',
            folder: `awas-v3/${vehiclePlate}/raw`,
            public_id: `raw_${Date.now()}`
        });
        const rawVideoUrl = videoUpload.secure_url;

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

        // WritRebate row created now, but isEligible defaults to false —
        // it only flips true once AiAssessment completes without fraud
        // flags (see runAiAssessment above).
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
                isEligible: false,
                isApplied: false
            }
        });

        // NOTE: writ fee invoice REMOVED from here — now bills at
        // uploadPoliceReport instead. See below.

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
// CHANGED: writ fee now bills HERE, at police report upload — the point
// where a writ becomes a real, verifiable claim, not just an app open.
// AI assessment still fires silently in the background as before.
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

        const parts = writNumber.split('-');
        const normalized = parts.length === 4
            ? `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`
            : writNumber;

        const log = await prisma.accidentLog.findUnique({
            where: { writNumber: normalized },
            include: {
                driver: { select: { vehiclePlate: true, vehicleType: true, insurerId: true, insurer: { select: { name: true } } } }
            }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });
        if (log.driver.vehiclePlate !== vehiclePlate) return res.status(403).json({ error: 'Akses ditolak.' });
        if (log.writStage !== 'SUBMITTED') return res.status(400).json({ error: 'Writ belum disubmit.' });
        if (log.policeReportUrl) return res.status(409).json({ error: 'Laporan polis sudah diupload untuk writ ini.' });

        const reportBuffer = req.files['policeReport'][0].buffer;
        const reportUpload = await uploadToCloudinary(reportBuffer, {
            resource_type: 'image',
            folder: `awas-v3/${vehiclePlate}/police-reports`,
            public_id: `police_${Date.now()}`
        });

        const now = new Date();

        await prisma.accidentLog.update({
            where: { id: log.id },
            data: {
                policeReportUrl: reportUpload.secure_url,
                policeReportNumber: policeReportNumber.toUpperCase().trim(),
                policeReportUploadedAt: now
            }
        });

        console.log(`AWAS V3: Police report uploaded for writ ${normalized} — Report No: ${policeReportNumber}`);

        // ─── Bill writ fee NOW — genuine, verifiable claim ────────────────────
        try {
            const unitFee = await getPricing('WRIT_FEE', log.driver.vehicleType);
            const invoiceNumber = await generateInvoiceNumber();

            await prisma.invoice.create({
                data: {
                    invoiceNumber,
                    insurerId: log.driver.insurerId,
                    invoiceType: 'WRIT',
                    periodStart: now,
                    periodEnd: now,
                    totalUnits: 1,
                    unitFee,
                    totalAmount: unitFee
                }
            });

            await prisma.accidentLog.update({
                where: { id: log.id },
                data: { writFeeBilledAt: now, writFeeInvoiceNumber: invoiceNumber }
            });

            console.log(`AWAS V3: Writ invoice ${invoiceNumber} — RM${unitFee} billed to insurer at police report upload`);
        } catch (invoiceErr) {
            console.error('AWAS V3: Writ invoice generation fault:', invoiceErr);
        }

        // ─── FIRE AI ASSESSMENT SILENTLY ──────────────────────────────────────
        setImmediate(() => {
            runAiAssessment(log.id).catch(err => {
                console.error(`AWAS V3: Silent AI assessment fault for log ${log.id}:`, err.message);
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

// ─── RETRY ASSESSMENT — HOC / EXECUTIVE / OFFICER ────────────────────────────
// NEW. Manual retry for a FAILED assessment. Unlike the silent background
// trigger, this is an explicit action — awaited, so the caller gets the
// real result back instead of a fire-and-forget response.
exports.retryAssessment = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;
        const { writNumber } = req.params;

        const parts = writNumber.split('-');
        const normalized = parts.length === 4
            ? `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`
            : writNumber;

        const log = await prisma.accidentLog.findUnique({
            where: { writNumber: normalized },
            include: { driver: { select: { insurerId: true } }, aiAssessment: true }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });
        if (log.driver.insurerId !== insurerId) return res.status(403).json({ error: 'Akses ditolak.' });
        if (!log.policeReportUrl) return res.status(400).json({ error: 'Laporan polis belum diupload lagi.' });
        if (log.aiAssessment && log.aiAssessment.status === 'COMPLETED') {
            return res.status(409).json({ error: 'Assessment sudah lengkap. Retry tidak diperlukan.' });
        }

        console.log(`AWAS V3: Manual retry assessment triggered for ${normalized} by insurerUser ${req.insurerUser.id}`);

        await runAiAssessment(log.id);

        const updated = await prisma.aiAssessment.findUnique({ where: { accidentLogId: log.id } });

        return res.status(200).json({
            message: updated.status === 'COMPLETED' ? 'Assessment berjaya dijana semula.' : 'Assessment masih gagal.',
            assessment: updated
        });

    } catch (error) {
        console.error('AWAS V3 retryAssessment Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa cuba semula assessment.' });
    }
};

// ─── ESCALATE TO MANUAL — HOC / EXECUTIVE / OFFICER ──────────────────────────
// NEW. All evidence (video/images/police report) is already fully uploaded —
// nothing is re-collected from the driver. This just assigns the writ to a
// specific subordinate for hands-on review instead of relying on AI.
exports.escalateToManual = async (req, res) => {
    try {
        const { insurerId, id: escalatedByUserId } = req.insurerUser;
        const { writNumber } = req.params;
        const { assignedToUserId, escalationNotes } = req.body;

        if (!assignedToUserId) return res.status(400).json({ error: 'assignedToUserId diperlukan.' });

        const assignee = await prisma.insurerUser.findUnique({ where: { id: parseInt(assignedToUserId) } });
        if (!assignee || assignee.insurerId !== insurerId) {
            return res.status(404).json({ error: 'Pengguna yang ditugaskan tidak dijumpai.' });
        }
        if (assignee.role === 'CLERICAL') {
            return res.status(400).json({ error: 'Clerical tidak boleh ditugaskan untuk siasatan tuntutan.' });
        }

        const parts = writNumber.split('-');
        const normalized = parts.length === 4
            ? `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`
            : writNumber;

        const log = await prisma.accidentLog.findUnique({
            where: { writNumber: normalized },
            include: { driver: { select: { insurerId: true } }, aiAssessment: true }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });
        if (log.driver.insurerId !== insurerId) return res.status(403).json({ error: 'Akses ditolak.' });
        if (!log.aiAssessment) return res.status(400).json({ error: 'Tiada AI assessment untuk writ ini lagi.' });

        const updated = await prisma.aiAssessment.update({
            where: { accidentLogId: log.id },
            data: {
                escalatedToManual: true,
                escalatedByUserId,
                assignedToUserId: parseInt(assignedToUserId),
                escalatedAt: new Date(),
                escalationNotes: escalationNotes || null,
                resolvedByUserId: null,
                resolvedAt: null,
                resolutionNotes: null
            }
        });

        console.log(`AWAS V3: Writ ${normalized} escalated to manual — assigned to insurerUser ${assignedToUserId}`);

        return res.status(200).json({
            message: `Tuntutan ditugaskan kepada ${assignee.name} untuk siasatan manual.`,
            assessment: updated
        });

    } catch (error) {
        console.error('AWAS V3 escalateToManual Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa menugaskan siasatan manual.' });
    }
};

// ─── RESOLVE ESCALATION — assigned user, or HOC ──────────────────────────────
// NEW. Closes the loop once the subordinate finishes their manual review.
exports.resolveEscalation = async (req, res) => {
    try {
        const { insurerId, id: userId, role } = req.insurerUser;
        const { writNumber } = req.params;
        const { resolutionNotes } = req.body;

        const parts = writNumber.split('-');
        const normalized = parts.length === 4
            ? `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`
            : writNumber;

        const log = await prisma.accidentLog.findUnique({
            where: { writNumber: normalized },
            include: { driver: { select: { insurerId: true } }, aiAssessment: true }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });
        if (log.driver.insurerId !== insurerId) return res.status(403).json({ error: 'Akses ditolak.' });
        if (!log.aiAssessment || !log.aiAssessment.escalatedToManual) {
            return res.status(400).json({ error: 'Tuntutan ini tidak dalam status ditugaskan.' });
        }
        if (log.aiAssessment.assignedToUserId !== userId && role !== 'HOC') {
            return res.status(403).json({ error: 'Hanya pengguna yang ditugaskan atau HOC boleh menyelesaikan siasatan ini.' });
        }

        const updated = await prisma.aiAssessment.update({
            where: { accidentLogId: log.id },
            data: {
                resolvedByUserId: userId,
                resolvedAt: new Date(),
                resolutionNotes: resolutionNotes || null
            }
        });

        console.log(`AWAS V3: Escalation resolved for writ ${normalized} by insurerUser ${userId}`);

        return res.status(200).json({
            message: 'Siasatan manual ditandakan selesai.',
            assessment: updated
        });

    } catch (error) {
        console.error('AWAS V3 resolveEscalation Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa menyelesaikan siasatan.' });
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
// Public — police-facing verification page. Deliberately excludes
// aiAssessment and cashSettlement — policyholder/public must NOT see AI data.
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
            }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });

        return res.status(200).json(log);

    } catch (error) {
        console.error('AWAS V3 getWritByNumber Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};