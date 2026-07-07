const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Resend } = require('resend');
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── HELPER: Generate temp password ──────────────────────────────────────────
function generateTempPassword() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
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

// ─── GET INSURER DASHBOARD — HOC ONLY ────────────────────────────────────────
exports.getDashboard = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        const [
            totalDrivers,
            activeDrivers,
            expiringDrivers,
            totalSubmittedWrits,
            submittedWritsToday,
            submittedWritsMonth,
            unpaidInvoices,
            totalUsers,
            pendingSettlements,
            acceptedSettlements
        ] = await Promise.all([
            prisma.driver.count({ where: { insurerId } }),
            prisma.driver.count({ where: { insurerId, status: 'ACTIVE' } }),
            prisma.driver.count({
                where: {
                    insurerId,
                    status: 'ACTIVE',
                    policyExpiry: {
                        gte: today,
                        lte: new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
                    }
                }
            }),
            prisma.accidentLog.count({
                where: { driver: { insurerId }, writStage: 'SUBMITTED' }
            }),
            prisma.accidentLog.count({
                where: { driver: { insurerId }, writStage: 'SUBMITTED', submittedAt: { gte: today } }
            }),
            prisma.accidentLog.count({
                where: { driver: { insurerId }, writStage: 'SUBMITTED', submittedAt: { gte: thisMonth } }
            }),
            prisma.invoice.count({ where: { insurerId, isPaid: false } }),
            prisma.insurerUser.count({ where: { insurerId } }),
            // V3: settlements awaiting HOC decision
            prisma.cashSettlement.count({ where: { insurerId, status: 'PENDING' } }),
            // V3: accepted settlements this month
            prisma.cashSettlement.count({
                where: {
                    insurerId,
                    status: 'ACCEPTED',
                    policyholderDecidedAt: { gte: thisMonth }
                }
            })
        ]);

        const insurer = await prisma.insurer.findUnique({
            where: { id: insurerId },
            select: { name: true, code: true, email: true, onboardingFee: true, writFee: true }
        });

        return res.status(200).json({
            totalDrivers,
            activeDrivers,
            expiringDrivers,
            totalSubmittedWrits,
            submittedWritsToday,
            submittedWritsMonth,
            unpaidInvoices,
            totalUsers,
            pendingSettlements,
            acceptedSettlements,
            insurer,
            insurerUser: req.insurerUser
        });

    } catch (error) {
        console.error('AWAS V3 Insurer Dashboard Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET MY POLICYHOLDERS — HOC + OFFICER ────────────────────────────────────
exports.getMyDrivers = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;
        const { status, search } = req.query;

        const where = { insurerId };
        if (status) where.status = status;
        if (search) {
            where.OR = [
                { vehiclePlate: { contains: search.toUpperCase() } },
                { policyNumber: { contains: search.toUpperCase() } },
                { email: { contains: search.toLowerCase() } }
            ];
        }

        const drivers = await prisma.driver.findMany({
            where,
            orderBy: { createdAt: 'desc' },
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
                createdAt: true,
                _count: { select: { accidentLogs: true } }
            }
        });

        return res.status(200).json({ count: drivers.length, drivers });

    } catch (error) {
        console.error('AWAS V3 getMyDrivers Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET MY WRITS — HOC + OFFICER ────────────────────────────────────────────
exports.getMyWrits = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;
        const { vehiclePlate, dateFrom, dateTo, claimType } = req.query;

        const where = {
            driver: { insurerId },
            writStage: 'SUBMITTED'
        };

        if (vehiclePlate) where.vehiclePlate = vehiclePlate.toUpperCase();
        if (claimType) where.claimType = claimType;

        if (dateFrom || dateTo) {
            where.submittedAt = {};
            if (dateFrom) where.submittedAt.gte = new Date(dateFrom);
            if (dateTo) where.submittedAt.lte = new Date(dateTo);
        }

        const writs = await prisma.accidentLog.findMany({
            where,
            orderBy: { submittedAt: 'desc' },
            include: {
                driver: {
                    select: {
                        vehiclePlate: true,
                        vehicleMakeModel: true,
                        vehicleType: true,
                        policyNumber: true,
                        phone: true,
                        email: true
                    }
                },
                aiAssessment: {
                    select: {
                        status: true,
                        totalEstimatedCost: true,
                        overallSeverity: true,
                        confidenceLevel: true,
                        sentToInsurerAt: true
                    }
                },
                cashSettlement: {
                    select: {
                        status: true,
                        offeredAmount: true,
                        offeredAt: true
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

// ─── GET SINGLE WRIT DETAIL — HOC + OFFICER ──────────────────────────────────
// V3: includes full aiAssessment and cashSettlement
exports.getWritDetail = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;
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
                        insurerId: true,
                        vehiclePlate: true,
                        vehicleMakeModel: true,
                        vehicleType: true,
                        policyNumber: true,
                        policyExpiry: true,
                        phone: true,
                        email: true
                    }
                },
                writRebate: true,
                aiAssessment: true,
                cashSettlement: true
            }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });
        if (log.driver.insurerId !== insurerId) return res.status(403).json({ error: 'Akses ditolak.' });
        if (log.writStage !== 'SUBMITTED') return res.status(403).json({ error: 'Writ belum disubmit.' });

        return res.status(200).json({ writ: log });

    } catch (error) {
        console.error('AWAS V3 getWritDetail Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET MY INVOICES — HOC + ACCOUNTS ────────────────────────────────────────
exports.getMyInvoices = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;

        const invoices = await prisma.invoice.findMany({
            where: { insurerId },
            orderBy: { createdAt: 'desc' }
        });

        return res.status(200).json({ count: invoices.length, invoices });

    } catch (error) {
        console.error('AWAS V3 getMyInvoices Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── CSV UPLOAD — HOC + OFFICER + BACKROOM ───────────────────────────────────
// V3: onboarding fee now read from PricingConfig by vehicleType per row
exports.uploadCsv = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;

        if (!req.file) return res.status(400).json({ error: 'Fail CSV diperlukan.' });

        const insurer = await prisma.insurer.findUnique({ where: { id: insurerId } });
        if (!insurer) return res.status(404).json({ error: 'Insurans tidak dijumpai.' });

        const csvContent = req.file.buffer.toString('utf8');
        const lines = csvContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        if (lines.length < 2) return res.status(400).json({ error: 'CSV kosong atau tiada data.' });

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, ''));
        const required = ['vehicleplate', 'email', 'policynumber', 'policyexpiry'];
        const missingHeaders = required.filter(r => !headers.includes(r));
        if (missingHeaders.length > 0) {
            return res.status(400).json({ error: `Header CSV tidak lengkap. Missing: ${missingHeaders.join(', ')}` });
        }

        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim());
            const row = {};
            headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
            rows.push(row);
        }

        let successRows = 0;
        let failedRows = 0;
        const errors = [];

        // Track new drivers per vehicleType for invoicing
        const newDriversByType = { CAR: 0, MOTORCYCLE: 0, LORRY: 0, BUS: 0, VAN: 0 };

        for (const row of rows) {
            try {
                const plate = (row['vehicleplate'] || '').toUpperCase().replace(/\s+/g, '');
                const policyNumber = (row['policynumber'] || '').toUpperCase().replace(/\s+/g, '');
                const email = (row['email'] || '').toLowerCase().trim();
                const policyExpiry = row['policyexpiry'];
                const vehicleType = (row['vehicletype'] || 'CAR').toUpperCase();

                if (!plate || !email || !policyNumber || !policyExpiry) {
                    failedRows++;
                    errors.push(`Row skipped — missing required fields: ${plate || 'no plate'}`);
                    continue;
                }

                const existing = await prisma.driver.findFirst({
                    where: { OR: [{ vehiclePlate: plate }, { policyNumber }] }
                });

                if (existing) {
                    await prisma.driver.update({
                        where: { vehiclePlate: plate },
                        data: {
                            policyExpiry: new Date(policyExpiry),
                            policyNumber,
                            status: 'ACTIVE',
                            vehicleMakeModel: row['vehiclemakemodel'] || existing.vehicleMakeModel,
                            phone: row['phone'] || existing.phone
                        }
                    });
                    successRows++;
                    continue;
                }

                const tempPassword = generateTempPassword();
                const passwordHash = await bcrypt.hash(tempPassword, 12);

                await prisma.driver.create({
                    data: {
                        insurerId,
                        vehiclePlate: plate,
                        vehicleMakeModel: row['vehiclemakemodel'] || 'Unknown',
                        vehicleType: vehicleType,
                        mykadLastFour: row['mykadlastfour'] || '0000',
                        phone: row['phone'] || '',
                        email,
                        passwordHash,
                        mustChangePassword: true,
                        policyNumber,
                        policyExpiry: new Date(policyExpiry),
                        status: 'ACTIVE'
                    }
                });

                // Track new driver by type
                if (newDriversByType.hasOwnProperty(vehicleType)) {
                    newDriversByType[vehicleType]++;
                } else {
                    newDriversByType['CAR']++;
                }

                try {
                    await resend.emails.send({
                        from: 'AWAS <hello@awas.asia>',
                        to: email,
                        subject: '[AWAS] Akaun AWAS Anda Telah Diaktifkan',
                        html: `
                            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                            <h2 style="color:#0f172a;">Selamat Datang ke AWAS</h2>
                            <p>Akaun AWAS anda telah diaktifkan melalui polisi insurans <strong>${insurer.name}</strong>.</p>
                            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                                <tr><td style="padding:8px;font-weight:700;color:#475569;">URL</td><td style="padding:8px;">${process.env.FE_URL}/login</td></tr>
                                <tr><td style="padding:8px;font-weight:700;color:#475569;">Nombor Plat (Username)</td><td style="padding:8px;font-weight:800;">${plate}</td></tr>
                                <tr><td style="padding:8px;font-weight:700;color:#475569;">Kata Laluan Sementara</td><td style="padding:8px;font-weight:800;color:#dc2626;">${tempPassword}</td></tr>
                            </table>
                            <p style="color:#dc2626;font-weight:700;">Sila tukar kata laluan anda selepas log masuk pertama.</p>
                            <div style="margin:24px 0;">
                                <a href="${process.env.FE_URL}" style="background:#16a34a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Buka AWAS</a>
                            </div>
                            <p style="font-size:0.75rem;color:#94a3b8;">Polisi: ${policyNumber} | Tamat: ${new Date(policyExpiry).toLocaleDateString('ms-MY')}</p>
                            </div>
                        `
                    });
                } catch (emailErr) {
                    console.error(`AWAS V3: Welcome email fault for ${plate}:`, emailErr);
                }

                successRows++;

            } catch (rowErr) {
                failedRows++;
                errors.push(`Row error: ${rowErr.message}`);
            }
        }

        await prisma.csvUpload.create({
            data: {
                insurerId,
                fileName: req.file.originalname || 'upload.csv',
                totalRows: rows.length,
                successRows,
                failedRows
            }
        });

        // ─── Generate ONBOARDING invoices per vehicleType from PricingConfig ──
        for (const [vehicleType, count] of Object.entries(newDriversByType)) {
            if (count === 0) continue;
            try {
                const unitFee = await getPricing('ONBOARDING_FEE', vehicleType);
                const invoiceNumber = await generateInvoiceNumber();
                const totalAmount = unitFee * count;
                const now = new Date();

                await prisma.invoice.create({
                    data: {
                        invoiceNumber,
                        insurerId,
                        invoiceType: 'ONBOARDING',
                        periodStart: now,
                        periodEnd: now,
                        totalUnits: count,
                        unitFee,
                        totalAmount
                    }
                });

                console.log(`AWAS V3: Onboarding invoice ${invoiceNumber} — ${count} ${vehicleType} × RM${unitFee} = RM${totalAmount}`);
            } catch (invErr) {
                console.error(`AWAS V3: Onboarding invoice fault for ${vehicleType}:`, invErr.message);
            }
        }

        const totalNewDrivers = Object.values(newDriversByType).reduce((a, b) => a + b, 0);

        return res.status(200).json({
            message: `CSV diproses. ${successRows} berjaya, ${failedRows} gagal.`,
            successRows,
            failedRows,
            newDriversCount: totalNewDrivers,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('AWAS V3 CSV Upload Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET CSV UPLOAD HISTORY — HOC + OFFICER + BACKROOM ───────────────────────
exports.getCsvUploads = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;
        const uploads = await prisma.csvUpload.findMany({
            where: { insurerId },
            orderBy: { uploadedAt: 'desc' },
            take: 50
        });
        return res.status(200).json({ count: uploads.length, uploads });
    } catch (error) {
        console.error('AWAS V3 getCsvUploads Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── CREATE INSURER USER — HOC ONLY ──────────────────────────────────────────
exports.createInsurerUser = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;
        const { name, email, role } = req.body;

        if (!name || !email || !role) {
            return res.status(400).json({ error: 'Nama, emel dan peranan diperlukan.' });
        }

        if (role === 'HOC') {
            return res.status(403).json({ error: 'Anda tidak boleh mencipta akaun HOC.' });
        }

        const validRoles = ['OFFICER', 'BACKROOM', 'ACCOUNTS'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: 'Peranan tidak sah.' });
        }

        const existing = await prisma.insurerUser.findUnique({
            where: { email: email.toLowerCase() }
        });
        if (existing) {
            return res.status(409).json({ error: 'Emel sudah digunakan.' });
        }

        const tempPassword = generateTempPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 12);

        const insurerUser = await prisma.insurerUser.create({
            data: {
                insurerId,
                name,
                email: email.toLowerCase(),
                passwordHash,
                role,
                mustChangePassword: true,
                status: 'ACTIVE'
            }
        });

        const insurer = await prisma.insurer.findUnique({
            where: { id: insurerId },
            select: { name: true }
        });

        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: insurerUser.email,
                subject: '[AWAS] Akaun Portal AWAS Anda Telah Dicipta',
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                    <h2 style="color:#0f172a;">Selamat Datang ke Portal AWAS</h2>
                    <p>Akaun portal AWAS anda telah dicipta oleh ${insurer.name}.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Portal URL</td><td style="padding:8px;">${process.env.FE_URL}/insurer/login</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Nama</td><td style="padding:8px;">${insurerUser.name}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Emel</td><td style="padding:8px;">${insurerUser.email}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Peranan</td><td style="padding:8px;">${insurerUser.role}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Kata Laluan Sementara</td><td style="padding:8px;font-weight:800;color:#dc2626;">${tempPassword}</td></tr>
                    </table>
                    <p style="color:#dc2626;font-weight:700;">Sila tukar kata laluan anda selepas log masuk pertama.</p>
                    <div style="margin:24px 0;">
                        <a href="${process.env.FE_URL}/insurer/login" style="background:#0f1623;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Log Masuk Portal</a>
                    </div>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('AWAS V3: InsurerUser welcome email fault:', emailErr);
        }

        return res.status(201).json({
            message: `Pengguna ${name} (${role}) berjaya dicipta.`,
            userId: insurerUser.id,
            role: insurerUser.role
        });

    } catch (error) {
        console.error('AWAS V3 createInsurerUser Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET INSURER USERS — HOC ONLY ────────────────────────────────────────────
exports.getInsurerUsers = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;

        const users = await prisma.insurerUser.findMany({
            where: { insurerId },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                status: true,
                mustChangePassword: true,
                createdAt: true
            }
        });

        return res.status(200).json({ count: users.length, users });

    } catch (error) {
        console.error('AWAS V3 getInsurerUsers Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── TOGGLE INSURER USER STATUS — HOC ONLY ───────────────────────────────────
exports.toggleInsurerUserStatus = async (req, res) => {
    try {
        const { insurerId, id: requesterId } = req.insurerUser;
        const { id } = req.params;

        const user = await prisma.insurerUser.findUnique({ where: { id: parseInt(id) } });
        if (!user) return res.status(404).json({ error: 'Pengguna tidak dijumpai.' });
        if (user.insurerId !== insurerId) return res.status(403).json({ error: 'Akses ditolak.' });
        if (user.id === requesterId) return res.status(400).json({ error: 'Anda tidak boleh menukar status akaun sendiri.' });
        if (user.role === 'HOC') return res.status(403).json({ error: 'Status HOC tidak boleh diubah.' });

        const newStatus = user.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
        await prisma.insurerUser.update({
            where: { id: parseInt(id) },
            data: { status: newStatus }
        });

        return res.status(200).json({ message: `${user.name} status dikemas kini kepada ${newStatus}.` });

    } catch (error) {
        console.error('AWAS V3 toggleInsurerUserStatus Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3: GET SETTLEMENTS — HOC ONLY ──────────────────────────────────────────
// Lists all CashSettlement records for this insurer.
// Filterable by status.
exports.getSettlements = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;
        const { status } = req.query;

        const where = { insurerId };
        if (status) where.status = status;

        const settlements = await prisma.cashSettlement.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                accidentLog: {
                    select: {
                        writNumber: true,
                        claimType: true,
                        submittedAt: true,
                        policeReportNumber: true,
                        policeReportUploadedAt: true,
                        driver: {
                            select: {
                                vehiclePlate: true,
                                vehicleMakeModel: true,
                                vehicleType: true,
                                policyNumber: true,
                                phone: true,
                                email: true
                            }
                        },
                        aiAssessment: {
                            select: {
                                status: true,
                                totalEstimatedCost: true,
                                overallSeverity: true,
                                confidenceLevel: true,
                                sentToInsurerAt: true
                            }
                        }
                    }
                }
            }
        });

        return res.status(200).json({ count: settlements.length, settlements });

    } catch (error) {
        console.error('AWAS V3 getSettlements Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3: GET SETTLEMENT DETAIL — HOC ONLY ────────────────────────────────────
// Full detail including AI assessment JSON and all docs.
exports.getSettlementDetail = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;
        const { id } = req.params;

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id: parseInt(id) },
            include: {
                accidentLog: {
                    include: {
                        driver: {
                            select: {
                                vehiclePlate: true,
                                vehicleMakeModel: true,
                                vehicleType: true,
                                policyNumber: true,
                                policyExpiry: true,
                                phone: true,
                                email: true
                            }
                        },
                        aiAssessment: true,
                        writRebate: true
                    }
                }
            }
        });

        if (!settlement) return res.status(404).json({ error: 'Settlement tidak dijumpai.' });
        if (settlement.insurerId !== insurerId) return res.status(403).json({ error: 'Akses ditolak.' });

        return res.status(200).json({ settlement });

    } catch (error) {
        console.error('AWAS V3 getSettlementDetail Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3: MAKE SETTLEMENT OFFER — HOC ONLY ────────────────────────────────────
// HOC reviews AI assessment and makes cash offer to policyholder.
// Creates OFFERED record. Notifies policyholder via email.
// Offer expires in 7 days.
exports.makeSettlementOffer = async (req, res) => {
    try {
        const { insurerId } = req.insurerUser;
        const { id } = req.params;
        const { offeredAmount } = req.body;

        if (!offeredAmount || isNaN(parseFloat(offeredAmount)) || parseFloat(offeredAmount) <= 0) {
            return res.status(400).json({ error: 'Jumlah tawaran tidak sah.' });
        }

        const settlement = await prisma.cashSettlement.findUnique({
            where: { id: parseInt(id) },
            include: {
                accidentLog: {
                    include: {
                        driver: {
                            select: {
                                vehiclePlate: true,
                                vehicleMakeModel: true,
                                vehicleType: true,
                                email: true,
                                phone: true,
                                policyNumber: true
                            }
                        },
                        aiAssessment: {
                            select: { totalEstimatedCost: true, overallSeverity: true }
                        }
                    }
                }
            }
        });

        if (!settlement) return res.status(404).json({ error: 'Settlement tidak dijumpai.' });
        if (settlement.insurerId !== insurerId) return res.status(403).json({ error: 'Akses ditolak.' });
        if (settlement.status !== 'PENDING') {
            return res.status(409).json({ error: `Settlement sudah dalam status ${settlement.status}. Tawaran tidak boleh dibuat.` });
        }

        const now = new Date();
        const offerExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await prisma.cashSettlement.update({
            where: { id: parseInt(id) },
            data: {
                status: 'OFFERED',
                offeredAmount: parseFloat(offeredAmount),
                offeredAt: now,
                offerExpiresAt
            }
        });

        const driver = settlement.accidentLog.driver;
        const writ = settlement.accidentLog;

        // Notify policyholder via email
        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: driver.email,
                subject: `[AWAS] Tawaran Penyelesaian Tunai — ${writ.writNumber}`,
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                    <h2 style="color:#0f172a;">💰 Tawaran Penyelesaian Tunai AWAS</h2>
                    <p>Syarikat insurans anda telah membuat tawaran penyelesaian tunai untuk tuntutan kemalangan anda.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Nombor Writ</td><td style="padding:8px;font-weight:800;">${writ.writNumber}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Kenderaan</td><td style="padding:8px;">${driver.vehicleMakeModel} (${driver.vehiclePlate})</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#47456;font-size:1.1rem;">Jumlah Tawaran</td><td style="padding:8px;font-weight:900;color:#16a34a;font-size:1.3rem;">RM ${parseFloat(offeredAmount).toFixed(2)}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Tawaran Tamat</td><td style="padding:8px;color:#dc2626;">${offerExpiresAt.toLocaleDateString('ms-MY')}</td></tr>
                    </table>
                    <p>Jika anda <strong>terima</strong>, wang akan dibayar terus ke akaun bank anda. Anda boleh membuat pembaikan di mana-mana bengkel pilihan anda sebagai pelanggan tunai.</p>
                    <p>Jika anda <strong>tolak</strong>, tuntutan akan diteruskan melalui saluran insurans biasa (Merimen).</p>
                    <div style="margin:24px 0;display:flex;gap:12px;">
                        <a href="${process.env.FE_URL}/settlement/${id}" style="background:#16a34a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Lihat Tawaran</a>
                    </div>
                    <p style="font-size:0.75rem;color:#94a3b8;">Tawaran ini sah sehingga ${offerExpiresAt.toLocaleDateString('ms-MY')} sahaja.</p>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('AWAS V3: Settlement offer email fault:', emailErr);
        }

        console.log(`AWAS V3: Settlement offer made — ID ${id} — RM${offeredAmount} — expires ${offerExpiresAt.toISOString()}`);

        return res.status(200).json({
            message: `Tawaran RM${parseFloat(offeredAmount).toFixed(2)} berjaya dihantar kepada ${driver.vehiclePlate}.`,
            settlementId: parseInt(id),
            offeredAmount: parseFloat(offeredAmount),
            offeredAt: now,
            offerExpiresAt,
            status: 'OFFERED'
        });

    } catch (error) {
        console.error('AWAS V3 makeSettlementOffer Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};