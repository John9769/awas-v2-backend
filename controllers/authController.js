const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Resend } = require('resend');
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── DRIVER LOGIN ─────────────────────────────────────────────────────────────
exports.driverLogin = async (req, res) => {
    try {
        const { vehiclePlate, password } = req.body;

        if (!vehiclePlate || !password) {
            return res.status(400).json({ error: 'Plat kenderaan dan kata laluan diperlukan.' });
        }

        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate },
            include: { insurer: { select: { name: true, code: true } } }
        });

        if (!driver) {
            return res.status(401).json({ error: 'Akaun tidak dijumpai.' });
        }

        if (driver.status !== 'ACTIVE') {
            return res.status(403).json({ error: 'Akaun anda tidak aktif. Sila hubungi syarikat insurans anda.' });
        }

        if (new Date() > new Date(driver.policyExpiry)) {
            return res.status(403).json({ error: 'Polisi insurans anda telah tamat. Sila hubungi syarikat insurans anda untuk memperbaharui.' });
        }

        if (!driver.passwordHash) {
            return res.status(401).json({ error: 'Kata laluan belum ditetapkan. Sila semak emel anda untuk kata laluan sementara.' });
        }

        const match = await bcrypt.compare(password, driver.passwordHash);
        if (!match) {
            return res.status(401).json({ error: 'Kata laluan tidak sah.' });
        }

        const token = jwt.sign(
            {
                id: driver.id,
                vehiclePlate: driver.vehiclePlate,
                insurerId: driver.insurerId
            },
            process.env.JWT_SECRET,
            { expiresIn: '12h' }
        );

        return res.status(200).json({
            message: 'Log masuk berjaya.',
            token,
            mustChangePassword: driver.mustChangePassword,
            driver: {
                vehiclePlate: driver.vehiclePlate,
                vehicleMakeModel: driver.vehicleMakeModel,
                vehicleType: driver.vehicleType,
                policyNumber: driver.policyNumber,
                policyExpiry: driver.policyExpiry,
                insurer: driver.insurer.name
            }
        });

    } catch (error) {
        console.error('AWAS V2 Driver Login Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── DRIVER CHANGE PASSWORD ───────────────────────────────────────────────────
// Used for first-time password change + regular change password
exports.driverChangePassword = async (req, res) => {
    try {
        const { vehiclePlate, currentPassword, newPassword } = req.body;

        if (!vehiclePlate || !currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Semua medan diperlukan.' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Kata laluan baru minimum 6 aksara.' });
        }

        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({ where: { vehiclePlate: plate } });
        if (!driver) {
            return res.status(404).json({ error: 'Akaun tidak dijumpai.' });
        }

        if (!driver.passwordHash) {
            return res.status(400).json({ error: 'Kata laluan belum ditetapkan.' });
        }

        const match = await bcrypt.compare(currentPassword, driver.passwordHash);
        if (!match) {
            return res.status(401).json({ error: 'Kata laluan semasa tidak sah.' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await prisma.driver.update({
            where: { vehiclePlate: plate },
            data: {
                passwordHash,
                mustChangePassword: false
            }
        });

        return res.status(200).json({ message: 'Kata laluan berjaya dikemas kini.' });

    } catch (error) {
        console.error('AWAS V2 Driver Change Password Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── DRIVER FORGOT PASSWORD ───────────────────────────────────────────────────
exports.driverForgotPassword = async (req, res) => {
    try {
        const { vehiclePlate } = req.body;

        if (!vehiclePlate) {
            return res.status(400).json({ error: 'Plat kenderaan diperlukan.' });
        }

        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({ where: { vehiclePlate: plate } });

        // Always return success — don't reveal if account exists
        if (!driver || !driver.email) {
            return res.status(200).json({ message: 'Jika akaun wujud, emel tetapan semula kata laluan telah dihantar.' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await prisma.driver.update({
            where: { vehiclePlate: plate },
            data: { resetToken, resetTokenExpiry }
        });

        const resetUrl = `${process.env.FE_URL}/reset-password?token=${resetToken}&type=driver`;

        await resend.emails.send({
            from: 'AWAS <hello@awas.asia>',
            to: driver.email,
            subject: '[AWAS] Tetapan Semula Kata Laluan',
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                <h2 style="color:#0f172a;">Tetapan Semula Kata Laluan AWAS</h2>
                <p>Kami menerima permintaan untuk menetapkan semula kata laluan akaun AWAS anda.</p>
                <p>Klik butang di bawah untuk menetapkan kata laluan baharu. Pautan ini sah selama <strong>1 jam</strong>.</p>
                <div style="margin:24px 0;">
                    <a href="${resetUrl}" style="background:#16a34a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Tetapkan Semula Kata Laluan</a>
                </div>
                <p style="font-size:0.8rem;color:#64748b;">Jika anda tidak membuat permintaan ini, abaikan emel ini. Kata laluan anda tidak akan berubah.</p>
                <p style="font-size:0.8rem;color:#64748b;">Nombor Plat: <strong>${plate}</strong></p>
                </div>
            `
        });

        return res.status(200).json({ message: 'Jika akaun wujud, emel tetapan semula kata laluan telah dihantar.' });

    } catch (error) {
        console.error('AWAS V2 Driver Forgot Password Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── DRIVER RESET PASSWORD ────────────────────────────────────────────────────
exports.driverResetPassword = async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token dan kata laluan baharu diperlukan.' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Kata laluan minimum 6 aksara.' });
        }

        const driver = await prisma.driver.findUnique({ where: { resetToken: token } });

        if (!driver) {
            return res.status(400).json({ error: 'Token tidak sah.' });
        }

        if (new Date() > new Date(driver.resetTokenExpiry)) {
            return res.status(400).json({ error: 'Token telah tamat tempoh. Sila minta semula.' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);

        await prisma.driver.update({
            where: { resetToken: token },
            data: {
                passwordHash,
                resetToken: null,
                resetTokenExpiry: null,
                mustChangePassword: false
            }
        });

        return res.status(200).json({ message: 'Kata laluan berjaya ditetapkan semula. Sila log masuk.' });

    } catch (error) {
        console.error('AWAS V2 Driver Reset Password Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── INSURER LOGIN ────────────────────────────────────────────────────────────
exports.insurerLogin = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Emel dan kata laluan diperlukan.' });
        }

        const insurer = await prisma.insurer.findUnique({
            where: { email: email.toLowerCase() }
        });

        if (!insurer) {
            return res.status(401).json({ error: 'Akaun tidak dijumpai.' });
        }

        if (insurer.status !== 'ACTIVE') {
            return res.status(403).json({ error: 'Akaun syarikat insurans tidak aktif.' });
        }

        const match = await bcrypt.compare(password, insurer.passwordHash);
        if (!match) {
            return res.status(401).json({ error: 'Kata laluan tidak sah.' });
        }

        const token = jwt.sign(
            {
                id: insurer.id,
                email: insurer.email,
                code: insurer.code,
                name: insurer.name
            },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        return res.status(200).json({
            message: 'Log masuk berjaya.',
            token,
            mustChangePassword: insurer.mustChangePassword,
            insurer: {
                name: insurer.name,
                code: insurer.code,
                email: insurer.email
            }
        });

    } catch (error) {
        console.error('AWAS V2 Insurer Login Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── INSURER CHANGE PASSWORD ──────────────────────────────────────────────────
exports.insurerChangePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const { id } = req.insurer;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Semua medan diperlukan.' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Kata laluan baru minimum 6 aksara.' });
        }

        const insurer = await prisma.insurer.findUnique({ where: { id } });
        if (!insurer) {
            return res.status(404).json({ error: 'Akaun tidak dijumpai.' });
        }

        const match = await bcrypt.compare(currentPassword, insurer.passwordHash);
        if (!match) {
            return res.status(401).json({ error: 'Kata laluan semasa tidak sah.' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await prisma.insurer.update({
            where: { id },
            data: {
                passwordHash,
                mustChangePassword: false
            }
        });

        return res.status(200).json({ message: 'Kata laluan berjaya dikemas kini.' });

    } catch (error) {
        console.error('AWAS V2 Insurer Change Password Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── INSURER FORGOT PASSWORD ──────────────────────────────────────────────────
exports.insurerForgotPassword = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Emel diperlukan.' });
        }

        const insurer = await prisma.insurer.findUnique({
            where: { email: email.toLowerCase() }
        });

        if (!insurer) {
            return res.status(200).json({ message: 'Jika akaun wujud, emel tetapan semula kata laluan telah dihantar.' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);

        await prisma.insurer.update({
            where: { email: email.toLowerCase() },
            data: { resetToken, resetTokenExpiry }
        });

        const resetUrl = `${process.env.FE_URL}/insurer/reset-password?token=${resetToken}`;

        await resend.emails.send({
            from: 'AWAS <hello@awas.asia>',
            to: insurer.email,
            subject: '[AWAS] Tetapan Semula Kata Laluan Portal Insurans',
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                <h2 style="color:#0f172a;">Tetapan Semula Kata Laluan</h2>
                <p>Permintaan tetapan semula kata laluan untuk akaun <strong>${insurer.name}</strong> telah diterima.</p>
                <p>Klik butang di bawah. Pautan sah selama <strong>1 jam</strong>.</p>
                <div style="margin:24px 0;">
                    <a href="${resetUrl}" style="background:#0f1623;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Tetapkan Semula Kata Laluan</a>
                </div>
                <p style="font-size:0.8rem;color:#64748b;">Jika anda tidak membuat permintaan ini, abaikan emel ini.</p>
                </div>
            `
        });

        return res.status(200).json({ message: 'Jika akaun wujud, emel tetapan semula kata laluan telah dihantar.' });

    } catch (error) {
        console.error('AWAS V2 Insurer Forgot Password Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── INSURER RESET PASSWORD ───────────────────────────────────────────────────
exports.insurerResetPassword = async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token dan kata laluan baharu diperlukan.' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Kata laluan minimum 6 aksara.' });
        }

        const insurer = await prisma.insurer.findUnique({ where: { resetToken: token } });

        if (!insurer) {
            return res.status(400).json({ error: 'Token tidak sah.' });
        }

        if (new Date() > new Date(insurer.resetTokenExpiry)) {
            return res.status(400).json({ error: 'Token telah tamat tempoh. Sila minta semula.' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);

        await prisma.insurer.update({
            where: { resetToken: token },
            data: {
                passwordHash,
                resetToken: null,
                resetTokenExpiry: null,
                mustChangePassword: false
            }
        });

        return res.status(200).json({ message: 'Kata laluan berjaya ditetapkan semula. Sila log masuk.' });

    } catch (error) {
        console.error('AWAS V2 Insurer Reset Password Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};