const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Paper = require('../models/Paper');
const { protect, requireRole } = require('../middleware/auth');

// ── GET /api/users — Search users ──
router.get('/', async (req, res, next) => {
  try {
    const { search, department, role, page = 1, limit = 12 } = req.query;
    const filter = { isActive: true };

    if (search) filter.$text = { $search: search };
    if (department) filter.department = department;
    if (role) filter.role = role;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(filter)
        .select('name institution department bio profilePhoto paperCount totalCitations hIndex role createdAt')
        .sort({ paperCount: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(filter)
    ]);

    res.json({ users, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/users/:id — Public profile ──
router.get('/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -verificationToken -resetPasswordToken -verificationTokenExpires -resetPasswordExpires')
      .populate('followers', 'name profilePhoto institution')
      .populate('following', 'name profilePhoto institution');

    if (!user || !user.isActive) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const papers = await Paper.find({ primaryAuthor: user._id, status: 'published' })
      .select('title department likes views citations createdAt keywords')
      .sort({ createdAt: -1 });

    res.json({ user, papers });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/users/me — Update own profile ──
router.patch('/me', protect, [
  body('name').optional().trim().isLength({ min: 1, max: 100 }),
  body('bio').optional().isLength({ max: 500 }),
  body('institution').optional().trim().isLength({ max: 200 }),
  body('department').optional().isIn(['cs_ai','space','medical_bio','mechanical','electrical','civil','environmental','aerospace','other','']),
  body('researchInterests').optional().isArray(),
  body('website').optional().isURL().withMessage('Invalid website URL').optional({ checkFalsy: true }),
  body('location').optional().isLength({ max: 100 }),
  body('orcidId').optional().isLength({ max: 30 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const allowed = ['name','bio','institution','department','researchInterests','website','location','orcidId'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true })
      .select('-password -verificationToken -resetPasswordToken -verificationTokenExpires -resetPasswordExpires');

    res.json({ user, message: 'Profile updated.' });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/users/me/password ──
router.patch('/me/password', protect, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/)
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.comparePassword(req.body.currentPassword))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    user.password = req.body.newPassword;
    await user.save();
    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/users/:id/follow ──
router.post('/:id/follow', protect, async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ error: 'You cannot follow yourself.' });
    }

    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const alreadyFollowing = req.user.following.includes(req.params.id);

    if (alreadyFollowing) {
      await User.findByIdAndUpdate(req.user._id, { $pull: { following: req.params.id } });
      await User.findByIdAndUpdate(req.params.id, { $pull: { followers: req.user._id } });
    } else {
      await User.findByIdAndUpdate(req.user._id, { $addToSet: { following: req.params.id } });
      await User.findByIdAndUpdate(req.params.id, { $addToSet: { followers: req.user._id } });
    }

    const updated = await User.findById(req.params.id).select('followers');
    res.json({ following: !alreadyFollowing, followerCount: updated.followers.length });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/users/me/saved ──
router.get('/me/saved', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
      .populate({
        path: 'savedPapers',
        populate: { path: 'primaryAuthor', select: 'name institution' }
      });
    res.json({ papers: user.savedPapers });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
