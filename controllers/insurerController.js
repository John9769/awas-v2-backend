const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Resend } = require('resend');
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── HELPER: Generate invoice number ─────────────────────────────────────────
async function generateInvoiceNumber() {
    const year = new Date().getFullYear();
    const count = await prisma.invoice.count();
    return `AWAS-INV-${year}-${String(count + 1).padStart(4, '0')}`;
}

// ─── GET INSURER DASHBOARD ────────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
    try {
        const { id: insurerId } = req.insurer;

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
            unpaidInvoices
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
            prisma.invoice.count({ where: { insurerId, isPaid: false } })
        ]);

        return res.status(200).json({
            totalDrivers,
            activeDrivers,
            expiringDrivers,
            totalSubmittedWrits,
            submittedWritsToday,
            submittedWritsMonth,
            unpaidInvoices,
            insurer: req.insurer
        });

    } catch (error) {
        console.error('AWAS V2 Insurer Dashboard Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET MY POLICYHOLDERS ─────────────────────────────────────────────────────
exports.getMyDrivers = async (req, res) => {
    try {
        const { id: insurerId } = req.insurer;
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
        console.error('AWAS V2 getMyDrivers Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET MY WRITS — SUBMITTED ONLY ───────────────────────────────────────────
exports.getMyWrits = async (req, res) => {
    try {
        const { id: insurerId } = req.insurer;
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
                }
            }
        });

        return res.status(200).json({ count: writs.length, writs });

    } catch (error) {
        console.error('AWAS V2 getMyWrits Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET SINGLE WRIT DETAIL ───────────────────────────────────────────────────
exports.getWritDetail = async (req, res) => {
    try {
        const { id: insurerId } = req.insurer;
        const { writNumber } = req.params;

        const parts = writNumber.split('-');
        let normalizedWritNumber;
        if (parts.length === 4) {
            normalizedWritNumber = parts[0] + '/' + parts[1] + '/' + parts[2] + '/' + parts[3];
        } else {
            normalizedWritNumber = writNumber;
        }

        const log = await prisma.accidentLog.findUnique({
            where: { writNumber: normalizedWritNumber },
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
                writRebate: true
            }
        });

        if (!log) return res.status(404).json({ error: 'Writ tidak dijumpai.' });
        if (log.driver.insurerId !== insurerId) return res.status(403).json({ error: 'Akses ditolak.' });
        if (log.writStage !== 'SUBMITTED') return res.status(403).json({ error: 'Writ belum disubmit.' });

        return res.status(200).json({ writ: log });

    } catch (error) {
        console.error('AWAS V2 getWritDetail Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET MY INVOICES ──────────────────────────────────────────────────────────
exports.getMyInvoices = async (req, res) => {
    try {
        const { id: insurerId } = req.insurer;

        const invoices = await prisma.invoice.findMany({
            where: { insurerId },
            orderBy: { createdAt: 'desc' }
        });

        return res.status(200).json({ count: invoices.length, invoices });

    } catch (error) {
        console.error('AWAS V2 getMyInvoices Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── CSV UPLOAD ───────────────────────────────────────────────────────────────
exports.uploadCsv = async (req, res) => {
    try {
        const { id: insurerId } = req.insurer;

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
        let newDriversCount = 0;

        for (const row of rows) {
            try {
                const plate = (row['vehicleplate'] || '').toUpperCase().replace(/\s+/g, '');
                const policyNumber = (row['policynumber'] || '').toUpperCase().replace(/\s+/g, '');
                const email = (row['email'] || '').toLowerCase().trim();
                const policyExpiry = row['policyexpiry'];

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
                        data: { policyExpiry: new Date(policyExpiry), policyNumber, status: 'ACTIVE' }
                    });
                    successRows++;
                    continue;
                }

                const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
                const passwordHash = await bcrypt.hash(tempPassword, 12);

                await prisma.driver.create({
                    data: {
                        insurerId,
                        vehiclePlate: plate,
                        vehicleMakeModel: row['vehiclemakemodel'] || 'Unknown',
                        vehicleType: row['vehicletype'] || 'CAR',
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

                newDriversCount++;

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
                                <tr><td style="padding:8px;font-weight:700;color:#475569;">URL</td><td style="padding:8px;">${process.env.FE_URL}</td></tr>
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
                    console.error(`AWAS V2: Welcome email fault for ${plate}:`, emailErr);
                }

                successRows++;

            } catch (rowErr) {
                failedRows++;
                errors.push(`Row error: ${rowErr.message}`);
            }
        }

        // Log CSV upload
        await prisma.csvUpload.create({
            data: {
                insurerId,
                fileName: req.file.originalname || 'upload.csv',
                totalRows: rows.length,
                successRows,
                failedRows
            }
        });

        // Auto-generate ONBOARDING invoice for new drivers only
        if (newDriversCount > 0) {
            const invoiceNumber = await generateInvoiceNumber();
            const unitFee = parseFloat(insurer.onboardingFee);
            const totalAmount = unitFee * newDriversCount;
            const now = new Date();

            await prisma.invoice.create({
                data: {
                    invoiceNumber,
                    insurerId,
                    invoiceType: 'ONBOARDING',
                    periodStart: now,
                    periodEnd: now,
                    totalUnits: newDriversCount,
                    unitFee,
                    totalAmount
                }
            });

            console.log(`AWAS V2: Onboarding invoice ${invoiceNumber} — ${newDriversCount} new drivers × RM${unitFee} = RM${totalAmount}`);
        }

        return res.status(200).json({
            message: `CSV diproses. ${successRows} berjaya, ${failedRows} gagal.`,
            successRows,
            failedRows,
            newDriversCount,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('AWAS V2 CSV Upload Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET CSV UPLOAD HISTORY ───────────────────────────────────────────────────
exports.getCsvUploads = async (req, res) => {
    try {
        const { id: insurerId } = req.insurer;
        const uploads = await prisma.csvUpload.findMany({
            where: { insurerId },
            orderBy: { uploadedAt: 'desc' },
            take: 50
        });
        return res.status(200).json({ count: uploads.length, uploads });
    } catch (error) {
        console.error('AWAS V2 getCsvUploads Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};