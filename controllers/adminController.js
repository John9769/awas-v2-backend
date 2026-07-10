const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Resend } = require('resend');
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── HELPER: Generate temporary password ─────────────────────────────────────
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

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        const [
            totalInsurers,
            activeInsurers,
            totalDrivers,
            activeDrivers,
            newDriversToday,
            newDriversMonth,
            totalWrits,
            submittedWrits,
            newWritsToday,
            newWritsMonth,
            totalInvoices,
            unpaidInvoices,
            totalInsurerUsers
        ] = await Promise.all([
            prisma.insurer.count(),
            prisma.insurer.count({ where: { status: 'ACTIVE' } }),
            prisma.driver.count(),
            prisma.driver.count({ where: { status: 'ACTIVE' } }),
            prisma.driver.count({ where: { createdAt: { gte: today } } }),
            prisma.driver.count({ where: { createdAt: { gte: thisMonth } } }),
            prisma.accidentLog.count(),
            prisma.accidentLog.count({ where: { writStage: 'SUBMITTED' } }),
            prisma.accidentLog.count({ where: { createdAt: { gte: today } } }),
            prisma.accidentLog.count({ where: { createdAt: { gte: thisMonth } } }),
            prisma.invoice.count(),
            prisma.invoice.count({ where: { isPaid: false } }),
            prisma.insurerUser.count()
        ]);

        return res.status(200).json({
            insurers: { total: totalInsurers, active: activeInsurers },
            drivers: { total: totalDrivers, active: activeDrivers, newToday: newDriversToday, newMonth: newDriversMonth },
            writs: { total: totalWrits, submitted: submittedWrits, newToday: newWritsToday, newMonth: newWritsMonth },
            invoices: { total: totalInvoices, unpaid: unpaidInvoices },
            insurerUsers: { total: totalInsurerUsers }
        });

    } catch (error) {
        console.error('AWAS V3 Admin Dashboard Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── CREATE INSURER ───────────────────────────────────────────────────────────
// FIXED: no longer sets onboardingFee/writFee — those columns are gone.
// Rates come exclusively from PricingConfig (global default) now.
// NEW: cashRebateEnabled can be set at creation time (defaults false).
exports.createInsurer = async (req, res) => {
    try {
        const { name, code, email, contactPerson, phone, cashRebateEnabled } = req.body;

        if (!name || !code || !email || !contactPerson || !phone) {
            return res.status(400).json({ error: 'Semua medan wajib diperlukan.' });
        }

        const existing = await prisma.insurer.findFirst({
            where: { OR: [{ email: email.toLowerCase() }, { code: code.toUpperCase() }] }
        });
        if (existing) {
            return res.status(409).json({ error: 'Emel atau kod insurans sudah wujud.' });
        }

        const insurer = await prisma.insurer.create({
            data: {
                name,
                code: code.toUpperCase(),
                email: email.toLowerCase(),
                contactPerson,
                phone,
                cashRebateEnabled: cashRebateEnabled === true
            }
        });

        console.log(`AWAS V3: Insurer ${insurer.name} created. Rebate enabled: ${insurer.cashRebateEnabled}`);

        return res.status(201).json({
            message: `Insurans ${insurer.name} berjaya dicipta. Sila cipta pengguna HOC untuk insurans ini.`,
            insurerId: insurer.id,
            code: insurer.code
        });

    } catch (error) {
        console.error('AWAS V3 Create Insurer Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── TOGGLE CASH REBATE — ADMIN ONLY ─────────────────────────────────────────
// NEW. Lets admin flip an insurer's rebate opt-in without recreating the
// insurer. Confirmed: this is the insurer's own choice, not forced by AWAS.
exports.toggleCashRebate = async (req, res) => {
    try {
        const { id } = req.params;
        const insurer = await prisma.insurer.findUnique({ where: { id: parseInt(id) } });
        if (!insurer) return res.status(404).json({ error: 'Insurans tidak dijumpai.' });

        const updated = await prisma.insurer.update({
            where: { id: parseInt(id) },
            data: { cashRebateEnabled: !insurer.cashRebateEnabled }
        });

        return res.status(200).json({
            message: `${insurer.name} cash rebate ${updated.cashRebateEnabled ? 'diaktifkan' : 'dinyahaktifkan'}.`,
            cashRebateEnabled: updated.cashRebateEnabled
        });
    } catch (error) {
        console.error('AWAS V3 toggleCashRebate Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── CREATE HOC USER FOR INSURER — ADMIN ONLY ─────────────────────────────────
exports.createHocUser = async (req, res) => {
    try {
        const { insurerId, name, email } = req.body;

        if (!insurerId || !name || !email) {
            return res.status(400).json({ error: 'insurerId, nama dan emel diperlukan.' });
        }

        const insurer = await prisma.insurer.findUnique({ where: { id: parseInt(insurerId) } });
        if (!insurer) return res.status(404).json({ error: 'Insurans tidak dijumpai.' });

        const existing = await prisma.insurerUser.findUnique({
            where: { email: email.toLowerCase() }
        });
        if (existing) return res.status(409).json({ error: 'Emel sudah digunakan.' });

        const existingHoc = await prisma.insurerUser.findFirst({
            where: { insurerId: parseInt(insurerId), role: 'HOC' }
        });
        if (existingHoc) return res.status(409).json({ error: 'HOC sudah wujud untuk insurans ini.' });

        const tempPassword = generateTempPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 12);

        const hocUser = await prisma.insurerUser.create({
            data: {
                insurerId: parseInt(insurerId),
                name,
                email: email.toLowerCase(),
                passwordHash,
                role: 'HOC',
                mustChangePassword: true,
                status: 'ACTIVE'
            }
        });

        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: hocUser.email,
                subject: '[AWAS] Akaun Head of Claims Portal AWAS',
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                    <h2 style="color:#0f172a;">Selamat Datang ke Portal AWAS</h2>
                    <p>Anda telah dilantik sebagai <strong>Head of Claims (HOC)</strong> untuk <strong>${insurer.name}</strong>.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Portal URL</td><td style="padding:8px;">${process.env.FE_URL}/insurer/login</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Nama</td><td style="padding:8px;">${hocUser.name}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Emel</td><td style="padding:8px;">${hocUser.email}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Peranan</td><td style="padding:8px;font-weight:800;color:#16a34a;">HEAD OF CLAIMS</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Kata Laluan Sementara</td><td style="padding:8px;font-weight:800;color:#dc2626;">${tempPassword}</td></tr>
                    </table>
                    <p style="color:#dc2626;font-weight:700;">Sila tukar kata laluan anda selepas log masuk pertama.</p>
                    <p>Sebagai HOC, anda boleh mencipta pengguna lain (Executive, Officer, Clerical) dari dalam portal.</p>
                    <div style="margin:24px 0;">
                        <a href="${process.env.FE_URL}/insurer/login" style="background:#0f1623;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Log Masuk Portal</a>
                    </div>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('AWAS V3: HOC welcome email fault:', emailErr);
        }

        console.log(`AWAS V3: HOC user ${hocUser.name} created for insurer ${insurer.name}`);

        return res.status(201).json({
            message: `HOC ${name} berjaya dicipta untuk ${insurer.name}. Emel selamat datang telah dihantar.`,
            userId: hocUser.id,
            role: hocUser.role
        });

    } catch (error) {
        console.error('AWAS V3 Create HOC User Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET ALL INSURERS ─────────────────────────────────────────────────────────
exports.getInsurers = async (req, res) => {
    try {
        const insurers = await prisma.insurer.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, name: true, code: true, email: true,
                contactPerson: true, phone: true, status: true,
                cashRebateEnabled: true, ownDamageRebatePercent: true, thirdPartyRebateFlat: true,
                createdAt: true,
                _count: { select: { drivers: true, invoices: true, insurerUsers: true } }
            }
        });
        return res.status(200).json({ count: insurers.length, insurers });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET INSURER USERS — ADMIN VIEW ──────────────────────────────────────────
exports.getInsurerUsers = async (req, res) => {
    try {
        const { insurerId } = req.query;
        const where = insurerId ? { insurerId: parseInt(insurerId) } : {};

        const users = await prisma.insurerUser.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, name: true, email: true, role: true,
                status: true, mustChangePassword: true, createdAt: true,
                insurer: { select: { name: true, code: true } }
            }
        });

        return res.status(200).json({ count: users.length, users });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── SUSPEND / ACTIVATE INSURER ───────────────────────────────────────────────
exports.toggleInsurerStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const insurer = await prisma.insurer.findUnique({ where: { id: parseInt(id) } });
        if (!insurer) return res.status(404).json({ error: 'Insurans tidak dijumpai.' });

        const newStatus = insurer.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
        await prisma.insurer.update({ where: { id: parseInt(id) }, data: { status: newStatus } });

        return res.status(200).json({ message: `${insurer.name} status dikemas kini kepada ${newStatus}.` });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── CSV UPLOAD — ADMIN ───────────────────────────────────────────────────────
// FIXED (real bug #1): vehicleType now uppercased, same as insurerController's
// version. FIXED (real bug #2): onboarding invoice now reads from
// PricingConfig per vehicleType instead of the deleted insurer.onboardingFee
// flat column — this admin path and the insurer-portal path now bill
// identically, closing the "two billing sources" bug for good.
exports.uploadCsv = async (req, res) => {
    try {
        const { insurerId } = req.body;

        if (!insurerId) return res.status(400).json({ error: 'insurerId diperlukan.' });
        if (!req.file) return res.status(400).json({ error: 'Fail CSV diperlukan.' });

        const insurer = await prisma.insurer.findUnique({ where: { id: parseInt(insurerId) } });
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
        const newDriversByType = { CAR: 0, MOTORCYCLE: 0, LORRY: 0, BUS: 0, VAN: 0 };

        for (const row of rows) {
            try {
                const plate = (row['vehicleplate'] || '').toUpperCase().replace(/\s+/g, '');
                const policyNumber = (row['policynumber'] || '').toUpperCase().replace(/\s+/g, '');
                const email = (row['email'] || '').toLowerCase().trim();
                const policyExpiry = row['policyexpiry'];
                const vehicleType = (row['vehicletype'] || 'CAR').toUpperCase(); // FIXED: was missing .toUpperCase()

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

                const tempPassword = generateTempPassword();
                const passwordHash = await bcrypt.hash(tempPassword, 12);

                await prisma.driver.create({
                    data: {
                        insurerId: parseInt(insurerId),
                        vehiclePlate: plate,
                        vehicleMakeModel: row['vehiclemakemodel'] || 'Unknown',
                        vehicleType,
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
                insurerId: parseInt(insurerId),
                fileName: req.file.originalname || 'upload.csv',
                totalRows: rows.length,
                successRows,
                failedRows
            }
        });

        // FIXED: bills per vehicleType from PricingConfig — same logic as
        // insurerController.uploadCsv now, no more divergent billing source.
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
                        insurerId: parseInt(insurerId),
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

        const newDriversCount = Object.values(newDriversByType).reduce((a, b) => a + b, 0);

        return res.status(200).json({
            message: `CSV diproses. ${successRows} berjaya, ${failedRows} gagal.`,
            successRows,
            failedRows,
            newDriversCount,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('AWAS V3 CSV Upload Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET ALL DRIVERS ──────────────────────────────────────────────────────────
exports.getDrivers = async (req, res) => {
    try {
        const { insurerId } = req.query;
        const where = insurerId ? { insurerId: parseInt(insurerId) } : {};

        const drivers = await prisma.driver.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, vehiclePlate: true, vehicleMakeModel: true,
                vehicleType: true, phone: true, email: true,
                policyNumber: true, policyExpiry: true, status: true,
                createdAt: true,
                insurer: { select: { name: true, code: true } },
                _count: { select: { accidentLogs: true } }
            }
        });

        return res.status(200).json({ count: drivers.length, drivers });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET ALL WRITS ────────────────────────────────────────────────────────────
exports.getWrits = async (req, res) => {
    try {
        const writs = await prisma.accidentLog.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, writNumber: true, vehiclePlate: true,
                writStage: true, logHash: true, videoHash: true,
                latitude: true, longitude: true, claimType: true,
                roadCondition: true, weatherCondition: true, injuryStatus: true,
                submittedAt: true, createdAt: true,
                writFeeBilledAt: true, writFeeInvoiceNumber: true,
                driver: { select: { insurer: { select: { name: true, code: true } } } },
                aiAssessment: {
                    select: { status: true, fraudFlagged: true, escalatedToManual: true }
                }
            }
        });
        return res.status(200).json({ count: writs.length, writs });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET ALL INVOICES ─────────────────────────────────────────────────────────
exports.getInvoices = async (req, res) => {
    try {
        const invoices = await prisma.invoice.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                insurer: { select: { name: true, code: true, email: true } }
            }
        });
        return res.status(200).json({ count: invoices.length, invoices });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── MARK INVOICE PAID ────────────────────────────────────────────────────────
exports.markInvoicePaid = async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await prisma.invoice.findUnique({ where: { id: parseInt(id) } });
        if (!invoice) return res.status(404).json({ error: 'Invois tidak dijumpai.' });
        if (invoice.isPaid) return res.status(409).json({ error: 'Invois sudah dibayar.' });

        await prisma.invoice.update({
            where: { id: parseInt(id) },
            data: { isPaid: true, paidAt: new Date() }
        });

        return res.status(200).json({ message: `Invois ${invoice.invoiceNumber} ditanda sebagai dibayar.` });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET CSV UPLOAD HISTORY ───────────────────────────────────────────────────
exports.getCsvUploads = async (req, res) => {
    try {
        const uploads = await prisma.csvUpload.findMany({
            orderBy: { uploadedAt: 'desc' },
            take: 50,
            include: {
                insurer: { select: { name: true, code: true } }
            }
        });
        return res.status(200).json({ count: uploads.length, uploads });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3: GET PRICING CONFIG ───────────────────────────────────────────────────
exports.getPricing = async (req, res) => {
    try {
        const configs = await prisma.pricingConfig.findMany({
            orderBy: [{ key: 'asc' }, { vehicleType: 'asc' }]
        });
        return res.status(200).json({ count: configs.length, configs });
    } catch (error) {
        console.error('AWAS V3 getPricing Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3: SEED / UPDATE PRICING CONFIG ────────────────────────────────────────
// FIXED: SETTLEMENT_FEE removed from here entirely — that enum value no
// longer exists in PricingKey. Only ONBOARDING_FEE and WRIT_FEE remain.
exports.updatePricing = async (req, res) => {
    try {
        const {
            onboarding_motorcycle = 3.00,
            onboarding_car = 5.00,
            writ_motorcycle = 6.00,
            writ_car = 10.00
        } = req.body;

        const configs = [
            { key: 'ONBOARDING_FEE', vehicleType: 'MOTORCYCLE', amount: parseFloat(onboarding_motorcycle), description: 'Onboarding fee per motorcycle policyholder per year' },
            { key: 'ONBOARDING_FEE', vehicleType: 'CAR', amount: parseFloat(onboarding_car), description: 'Onboarding fee per car policyholder per year' },
            { key: 'WRIT_FEE', vehicleType: 'MOTORCYCLE', amount: parseFloat(writ_motorcycle), description: 'Writ submission fee per motorcycle claim, billed at police report upload' },
            { key: 'WRIT_FEE', vehicleType: 'CAR', amount: parseFloat(writ_car), description: 'Writ submission fee per car claim, billed at police report upload' }
        ];

        const results = [];
        for (const config of configs) {
            const result = await prisma.pricingConfig.upsert({
                where: { key_vehicleType: { key: config.key, vehicleType: config.vehicleType } },
                update: { amount: config.amount, description: config.description },
                create: { key: config.key, vehicleType: config.vehicleType, amount: config.amount, currency: 'MYR', description: config.description }
            });
            results.push(result);
        }

        console.log(`AWAS V3: PricingConfig seeded/updated — ${results.length} rows`);

        return res.status(200).json({ message: `${results.length} pricing configs updated.`, configs: results });

    } catch (error) {
        console.error('AWAS V3 updatePricing Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3 NEW: GET SETTLEMENT FEE TIERS ────────────────────────────────────────
exports.getSettlementFeeTiers = async (req, res) => {
    try {
        const tiers = await prisma.settlementFeeTier.findMany({
            orderBy: [{ vehicleType: 'asc' }, { minAmount: 'asc' }]
        });
        return res.status(200).json({ count: tiers.length, tiers });
    } catch (error) {
        console.error('AWAS V3 getSettlementFeeTiers Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── V3 NEW: SEED / UPDATE SETTLEMENT FEE TIERS ──────────────────────────────
// Replaces the old flat RM60/RM100 SETTLEMENT_FEE. Accepts a full array of
// tier rows so you can define exact bands + the claim-value ceiling per
// vehicleType. Wipes and re-inserts per vehicleType to avoid orphaned
// overlapping bands from partial updates — this table changes shape more
// than PricingConfig does (bands can be added/removed, not just amounts).
//
// Expected body shape:
// {
//   "tiers": [
//     { "vehicleType": "CAR", "minAmount": 0, "maxAmount": 5000, "fee": 100, "isEligibleForCashSettlement": true },
//     { "vehicleType": "CAR", "minAmount": 5000, "maxAmount": 20000, "fee": 150, "isEligibleForCashSettlement": true },
//     { "vehicleType": "CAR", "minAmount": 20000, "maxAmount": null, "fee": null, "isEligibleForCashSettlement": false },
//     { "vehicleType": "MOTORCYCLE", "minAmount": 0, "maxAmount": 3000, "fee": 60, "isEligibleForCashSettlement": true },
//     { "vehicleType": "MOTORCYCLE", "minAmount": 3000, "maxAmount": null, "fee": null, "isEligibleForCashSettlement": false }
//   ]
// }
exports.updateSettlementFeeTiers = async (req, res) => {
    try {
        const { tiers } = req.body;

        if (!Array.isArray(tiers) || tiers.length === 0) {
            return res.status(400).json({ error: 'tiers array diperlukan.' });
        }

        const affectedVehicleTypes = [...new Set(tiers.map(t => t.vehicleType))];

        const result = await prisma.$transaction(async (tx) => {
            await tx.settlementFeeTier.deleteMany({
                where: { vehicleType: { in: affectedVehicleTypes } }
            });

            const created = [];
            for (const tier of tiers) {
                if (!tier.vehicleType || tier.minAmount === undefined) {
                    throw new Error('Setiap tier perlu ada vehicleType dan minAmount.');
                }
                const row = await tx.settlementFeeTier.create({
                    data: {
                        vehicleType: tier.vehicleType,
                        minAmount: parseFloat(tier.minAmount),
                        maxAmount: tier.maxAmount !== null && tier.maxAmount !== undefined ? parseFloat(tier.maxAmount) : null,
                        fee: tier.fee !== null && tier.fee !== undefined ? parseFloat(tier.fee) : null,
                        isEligibleForCashSettlement: tier.isEligibleForCashSettlement !== false,
                        description: tier.description || null
                    }
                });
                created.push(row);
            }
            return created;
        });

        console.log(`AWAS V3: SettlementFeeTier updated — ${result.length} rows across ${affectedVehicleTypes.join(', ')}`);

        return res.status(200).json({ message: `${result.length} settlement fee tiers updated.`, tiers: result });

    } catch (error) {
        console.error('AWAS V3 updateSettlementFeeTiers Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan: ' + error.message });
    }
};

module.exports = exports;