const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

// ── Email Transport ──
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });

// ── POST /api/auth/signup ──
router.post('/signup', [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  body('role').optional().isIn(['researcher', 'reviewer', 'editor'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password, role } = req.body;

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const user = await User.create({
      name,
      email,
      password,
      role: role || 'researcher',
      verificationToken,
      verificationTokenExpires: Date.now() + 24 * 60 * 60 * 1000
    });

    // Send verification email
    const verifyUrl = `${process.env.CLIENT_URL}/pages/verify-email.html?token=${verificationToken}`;
    try {
      await transporter.sendMail({
        from: `MANI Research <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Verify your MANI Research account',
        html: `
          <h2>Welcome to MANI Research, ${name}!</h2>
          <p>Please verify your email address to activate your account.</p>
          <a href="${verifyUrl}" style="background:#4FFFB0;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;">
            Verify Email
          </a>
          <p>This link expires in 24 hours.</p>
        `
      });
    } catch (emailErr) {
      console.error('Email send failed:', emailErr.message);
    }

    res.status(201).json({
      message: 'Account created. Please check your email to verify your account.',
      userId: user._id
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ──
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.isVerified) {
      return res.status(403).json({ error: 'Please verify your email before logging in.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ error: 'Your account has been deactivated. Contact support.' });
    }

    user.lastSeen = new Date();
    await user.save({ validateBeforeSave: false });

    const token = signToken(user._id);
    res.json({
      token,
      user: user.toPublicJSON()
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/verify-email ──
router.get('/verify-email', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Verification token missing.' });

    const user = await User.findOne({
      verificationToken: token,
      verificationTokenExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification link.' });
    }

    user.isVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save({ validateBeforeSave: false });

    res.json({ message: 'Email verified successfully. You can now log in.' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/forgot-password ──
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail()
], async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      // Always return success to prevent email enumeration
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 60 * 60 * 1000; // 1 hour
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.CLIENT_URL}/pages/reset-password.html?token=${resetToken}`;
    try {
      await transporter.sendMail({
        from: `MANI Research <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Reset your MANI Research password',
        html: `
          <h2>Password Reset Request</h2>
          <p>Click below to reset your password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="background:#4FFFB0;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;">
            Reset Password
          </a>
          <p>If you didn't request this, ignore this email.</p>
        `
      });
    } catch (emailErr) {
      console.error('Email send failed:', emailErr.message);
    }

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/reset-password ──
router.post('/reset-password', [
  body('token').notEmpty(),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Must contain uppercase')
    .matches(/[0-9]/).withMessage('Must contain a number')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token, password } = req.body;
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──
router.get('/me', protect, async (req, res) => {
  res.json({ user: req.user.toPublicJSON() });
});

module.exports = router;
