const { PrismaClient } = require('@prisma/client');
const cloudinary = require('cloudinary').v2;
const prisma = new PrismaClient();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

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

// ─── HELPER: Generate invoice number ─────────────────────────────────────────
async function generateInvoiceNumber() {
    const year = new Date().getFullYear();
    const count = await prisma.invoice.count();
    return `AWAS-INV-${year}-${String(count + 1).padStart(4, '0')}`;
}

// ─── HELPER: Get pricing from DB ─────────────────────────────────────────────
async function getPricing(key, vehicleType) {
    const config = await prisma.pricingConfig.findUnique({
        where: { key_vehicleType: { key, vehicleType } }
    });
    if (!config) throw new Error(`PricingConfig missing: ${key} / ${vehicleType}`);
    return parseFloat(config.amount);
}

// ─── HELPER: Find matching SettlementFeeTier for a claim amount ──────────────
// FIXED: replaces the old getPricing('SETTLEMENT_FEE', vehicleType) call —
// that PricingKey no longer exists in the schema (settlement fees moved to
// tiered bands to avoid a percentage-of-AI's-own-estimate conflict of
// interest). This mirrors the identical helper in insurerController so both
// files agree on which tier/fee applies to a given claim.
async function findSettlementTier(vehicleType, claimAmount) {
    const tiers = await prisma.settlementFeeTier.findMany({
        where: { vehicleType },
        orderBy: { minAmount: 'asc' }
    });

    for (const tier of tiers) {
        const min = parseFloat(tier.minAmount);
        const max = tier.maxAmount !== null ? parseFloat(tier.maxAmount) : null;
        if (claimAmount >= min && (max === null || claimAmount < max)) {
            return tier;
        }
    }
    return null;
}

// ─── GET PROFILE ──────────────────────────────────────────────────────────────
exports.getProfile = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate },
            select: {
                id: true,
                vehiclePlate: true,
                vehicleMakeModel: true,
                vehicleType: true,
                phone: true,
                email: true,
                policyNumber: true,
                policyExpiry: true,
                status: true,
                mustChangePassword: true,
                createdAt: true,
                insurer: {
                    select: { name: true, code: true, phone: true, email: true }
                }
            }
        });

        if (!driver) return res.status(404).json({ error: 'Akaun tidak dijumpai.' });

        return res.status(200).json({ driver });

    } catch (error) {
        console.error('AWAS V3 getProfile Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET MY HISTORY ───────────────────────────────────────────────────────────
exports.getMyHistory = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;

        const logs = await prisma.accidentLog.findMany({
            where: { vehiclePlate },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                writNumber: true,
                writStage: true,
                claimType: true,
                submittedAt: true,
                policeReportNumber: true,
                policeReportUploadedAt: true,
                roadCondition: true,
                weatherCondition: true,
                injuryStatus: true,
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

        return res.status(200).json({ count: logs.length, logs });

    } catch (error) {
        console.error('AWAS V3 getMyHistory Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3: GET MY SETTLEMENT OFFER ──────────────────────────────────────────────
// Driver views their active settlement offer for a specific writ.
// Route: GET /driver/settlement/:settlementId
// Does NOT expose AI assessment data — driver never sees this.
exports.getMySettlement = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;
        const { settlementId } = req.params;

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id: parseInt(settlementId) },
            include: {
                accidentLog: {
                    select: {
                        writNumber: true,
                        claimType: true,
                        vehiclePlate: true,
                        policeReportNumber: true,
                        submittedAt: true
                        // NOTE: aiAssessment deliberately excluded — driver must NOT see AI data
                    }
                }
            }
        });

        if (!settlement) return res.status(404).json({ error: 'Settlement tidak dijumpai.' });
        if (settlement.accidentLog.vehiclePlate !== vehiclePlate) {
            return res.status(403).json({ error: 'Akses ditolak.' });
        }

        // Check if offer has expired
        if (
            settlement.status === 'OFFERED' &&
            settlement.offerExpiresAt &&
            new Date() > new Date(settlement.offerExpiresAt)
        ) {
            // Auto-expire
            await prisma.cashSettlement.update({
                where: { id: parseInt(settlementId) },
                data: { status: 'EXPIRED' }
            });
            settlement.status = 'EXPIRED';
        }

        // Return only what driver needs — no AI data
        return res.status(200).json({
            settlementId: settlement.id,
            status: settlement.status,
            offeredAmount: settlement.offeredAmount,
            offeredAt: settlement.offeredAt,
            offerExpiresAt: settlement.offerExpiresAt,
            policyholderDecidedAt: settlement.policyholderDecidedAt,
            writ: settlement.accidentLog
        });

    } catch (error) {
        console.error('AWAS V3 getMySettlement Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3: ACCEPT SETTLEMENT OFFER ─────────────────────────────────────────────
// Driver accepts cash offer.
// Status → ACCEPTED.
// Does NOT collect docs yet — docs uploaded separately via uploadSettlementDocs.
// PDPA: no sensitive docs collected here.
exports.acceptSettlementOffer = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;
        const { settlementId } = req.params;

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id: parseInt(settlementId) },
            include: {
                accidentLog: {
                    select: { vehiclePlate: true, writNumber: true }
                }
            }
        });

        if (!settlement) return res.status(404).json({ error: 'Settlement tidak dijumpai.' });
        if (settlement.accidentLog.vehiclePlate !== vehiclePlate) {
            return res.status(403).json({ error: 'Akses ditolak.' });
        }
        if (settlement.status !== 'OFFERED') {
            return res.status(409).json({ error: `Tawaran tidak boleh diterima. Status semasa: ${settlement.status}` });
        }
        if (settlement.offerExpiresAt && new Date() > new Date(settlement.offerExpiresAt)) {
            await prisma.cashSettlement.update({
                where: { id: parseInt(settlementId) },
                data: { status: 'EXPIRED' }
            });
            return res.status(410).json({ error: 'Tawaran telah tamat tempoh.' });
        }

        await prisma.cashSettlement.update({
            where: { id: parseInt(settlementId) },
            data: {
                status: 'ACCEPTED',
                policyholderDecidedAt: new Date()
            }
        });

        console.log(`AWAS V3: Settlement ACCEPTED — ID ${settlementId} — ${vehiclePlate}`);

        return res.status(200).json({
            message: 'Tawaran diterima. Sila upload dokumen yang diperlukan untuk meneruskan pembayaran.',
            settlementId: parseInt(settlementId),
            status: 'ACCEPTED',
            nextStep: 'UPLOAD_DOCS'
        });

    } catch (error) {
        console.error('AWAS V3 acceptSettlementOffer Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3: REJECT SETTLEMENT OFFER ─────────────────────────────────────────────
// Driver rejects cash offer → exits to Merimen route.
// No settlement fee charged to insurer.
exports.rejectSettlementOffer = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;
        const { settlementId } = req.params;

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id: parseInt(settlementId) },
            include: {
                accidentLog: {
                    select: { vehiclePlate: true, writNumber: true }
                }
            }
        });

        if (!settlement) return res.status(404).json({ error: 'Settlement tidak dijumpai.' });
        if (settlement.accidentLog.vehiclePlate !== vehiclePlate) {
            return res.status(403).json({ error: 'Akses ditolak.' });
        }
        if (settlement.status !== 'OFFERED') {
            return res.status(409).json({ error: `Tawaran tidak boleh ditolak. Status semasa: ${settlement.status}` });
        }

        await prisma.cashSettlement.update({
            where: { id: parseInt(settlementId) },
            data: {
                status: 'REJECTED',
                policyholderDecidedAt: new Date()
            }
        });

        console.log(`AWAS V3: Settlement REJECTED — ID ${settlementId} — ${vehiclePlate} — exits to Merimen`);

        return res.status(200).json({
            message: 'Tawaran ditolak. Tuntutan anda akan diteruskan melalui saluran insurans biasa (Merimen).',
            settlementId: parseInt(settlementId),
            status: 'REJECTED'
        });

    } catch (error) {
        console.error('AWAS V3 rejectSettlementOffer Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3: UPLOAD SETTLEMENT DOCS ───────────────────────────────────────────────
// Called ONLY after driver ACCEPTS offer.
// Collects: IC copy, driving licence, VOC, discharge voucher, bank details.
// PDPA: sensitive docs collected here ONLY — never before acceptance.
// FIXED: settlement fee now comes from SettlementFeeTier (tiered bands
// based on AI's estimated claim amount), not the deleted flat
// PricingConfig SETTLEMENT_FEE row.
exports.uploadSettlementDocs = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;
        const { settlementId } = req.params;
        const { bankAccountNumber, bankName, bankAccountName } = req.body;

        if (!bankAccountNumber || !bankName || !bankAccountName) {
            return res.status(400).json({ error: 'Maklumat bank diperlukan: bankAccountNumber, bankName, bankAccountName.' });
        }

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id: parseInt(settlementId) },
            include: {
                accidentLog: {
                    include: {
                        driver: {
                            select: {
                                vehiclePlate: true,
                                vehicleType: true,
                                insurerId: true,
                                insurer: { select: { id: true, name: true } }
                            }
                        },
                        aiAssessment: { select: { totalEstimatedCost: true } }
                    }
                }
            }
        });

        if (!settlement) return res.status(404).json({ error: 'Settlement tidak dijumpai.' });
        if (settlement.accidentLog.driver.vehiclePlate !== vehiclePlate) {
            return res.status(403).json({ error: 'Akses ditolak.' });
        }
        if (settlement.status !== 'ACCEPTED') {
            return res.status(409).json({ error: 'Dokumen hanya boleh diupload selepas tawaran diterima.' });
        }
        if (settlement.docsSubmittedAt) {
            return res.status(409).json({ error: 'Dokumen sudah diupload.' });
        }

        // Upload each doc to Cloudinary
        const uploadDoc = async (fileKey, folder) => {
            if (req.files && req.files[fileKey] && req.files[fileKey][0]) {
                const buf = req.files[fileKey][0].buffer;
                const result = await uploadToCloudinary(buf, {
                    resource_type: 'image',
                    folder: `awas-v3/${vehiclePlate}/settlement-docs`,
                    public_id: `${folder}_${Date.now()}`
                });
                return result.secure_url;
            }
            return null;
        };

        const [icUrl, licenceUrl, vocUrl, dischargeVoucherUrl] = await Promise.all([
            uploadDoc('ic', 'ic'),
            uploadDoc('licence', 'licence'),
            uploadDoc('voc', 'voc'),
            uploadDoc('dischargeVoucher', 'discharge')
        ]);

        const now = new Date();
        const driver = settlement.accidentLog.driver;
        const vehicleType = driver.vehicleType;
        const estimatedCost = settlement.accidentLog.aiAssessment?.totalEstimatedCost
            ? parseFloat(settlement.accidentLog.aiAssessment.totalEstimatedCost)
            : null;

        let settlementFee = 0;
        let invoiceNumber = null;
        try {
            if (estimatedCost === null) throw new Error('No AI assessment total found — cannot determine settlement fee tier');

            const tier = await findSettlementTier(vehicleType, estimatedCost);
            if (!tier || !tier.isEligibleForCashSettlement || tier.fee === null) {
                throw new Error(`No eligible settlement fee tier for ${vehicleType} at RM${estimatedCost}`);
            }

            settlementFee = parseFloat(tier.fee);
            invoiceNumber = await generateInvoiceNumber();

            await prisma.invoice.create({
                data: {
                    invoiceNumber,
                    insurerId: driver.insurerId,
                    invoiceType: 'SETTLEMENT',
                    periodStart: now,
                    periodEnd: now,
                    totalUnits: 1,
                    unitFee: settlementFee,
                    totalAmount: settlementFee
                }
            });

            console.log(`AWAS V3: Settlement invoice ${invoiceNumber} — RM${settlementFee} (tier-based) billed to insurer ${driver.insurer.name}`);
        } catch (feeErr) {
            console.error('AWAS V3: Settlement fee billing fault:', feeErr.message);
            // Non-fatal — docs still saved even if fee billing fails; shouldn't
            // normally trigger since makeSettlementOffer already validated
            // tier eligibility before the offer was ever made.
        }

        // Save docs + billing info
        await prisma.cashSettlement.update({
            where: { id: parseInt(settlementId) },
            data: {
                icUrl,
                licenceUrl,
                vocUrl,
                dischargeVoucherUrl,
                bankAccountNumber: bankAccountNumber.trim(),
                bankName: bankName.trim(),
                bankAccountName: bankAccountName.trim(),
                docsSubmittedAt: now,
                settlementFee: settlementFee || null,
                feeBilledAt: invoiceNumber ? now : null,
                feeInvoiceNumber: invoiceNumber || null
            }
        });

        console.log(`AWAS V3: Settlement docs uploaded — ID ${settlementId} — ${vehiclePlate}`);

        return res.status(200).json({
            message: 'Dokumen berjaya diupload. Pembayaran akan diproses oleh syarikat insurans anda.',
            settlementId: parseInt(settlementId),
            docsSubmittedAt: now,
            settlementFee,
            feeInvoiceNumber: invoiceNumber
        });

    } catch (error) {
        console.error('AWAS V3 uploadSettlementDocs Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa mengupload dokumen.' });
    }
};

// ─── V3 NEW: GET NOTIFICATIONS — driver ──────────────────────────────────────
// In-app notifications, primary channel (email is backup, sent in parallel
// by insurerController's makeSettlementOffer). Scoped narrow — settlement
// offers only, per today's decision to not flood the app with every event.
exports.getNotifications = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;

        const driver = await prisma.driver.findUnique({ where: { vehiclePlate }, select: { id: true } });
        if (!driver) return res.status(404).json({ error: 'Akaun tidak dijumpai.' });

        const notifications = await prisma.driverNotification.findMany({
            where: { driverId: driver.id },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        const unreadCount = await prisma.driverNotification.count({
            where: { driverId: driver.id, isRead: false }
        });

        return res.status(200).json({ count: notifications.length, unreadCount, notifications });

    } catch (error) {
        console.error('AWAS V3 getNotifications Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3 NEW: MARK NOTIFICATION READ — driver ─────────────────────────────────
exports.markNotificationRead = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;
        const { id } = req.params;

        const driver = await prisma.driver.findUnique({ where: { vehiclePlate }, select: { id: true } });
        if (!driver) return res.status(404).json({ error: 'Akaun tidak dijumpai.' });

        const notification = await prisma.driverNotification.findUnique({ where: { id: parseInt(id) } });
        if (!notification) return res.status(404).json({ error: 'Notifikasi tidak dijumpai.' });
        if (notification.driverId !== driver.id) return res.status(403).json({ error: 'Akses ditolak.' });

        await prisma.driverNotification.update({
            where: { id: parseInt(id) },
            data: { isRead: true, readAt: new Date() }
        });

        return res.status(200).json({ message: 'Notifikasi ditanda sebagai dibaca.' });

    } catch (error) {
        console.error('AWAS V3 markNotificationRead Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};