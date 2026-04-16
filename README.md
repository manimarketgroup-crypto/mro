const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Paper = require('../models/Paper');
const Review = require('../models/Review');
const Comment = require('../models/Comment');
const { protect, requireRole } = require('../middleware/auth');

// All admin routes require authentication + admin role
router.use(protect, requireRole('admin', 'editor'));

// ── GET /api/admin/stats — Dashboard overview ──
router.get('/stats', async (req, res, next) => {
  try {
    const [
      totalUsers,
      totalPapers,
      pendingPapers,
      publishedPapers,
      underReview,
      totalComments,
      newUsersThisMonth,
      newPapersThisMonth
    ] = await Promise.all([
      User.countDocuments({ isActive: true }),
      Paper.countDocuments(),
      Paper.countDocuments({ status: 'submitted' }),
      Paper.countDocuments({ status: 'published' }),
      Paper.countDocuments({ status: 'under_review' }),
      Comment.countDocuments({ isDeleted: false }),
      User.countDocuments({ createdAt: { $gte: new Date(new Date().setDate(1)) } }),
      Paper.countDocuments({ createdAt: { $gte: new Date(new Date().setDate(1)) } })
    ]);

    // Papers by department
    const byDept = await Paper.aggregate([
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Papers by status
    const byStatus = await Paper.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    res.json({
      totals: { totalUsers, totalPapers, pendingPapers, publishedPapers, underReview, totalComments },
      growth: { newUsersThisMonth, newPapersThisMonth },
      byDepartment: byDept,
      byStatus
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/users ──
router.get('/users', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, role, isActive } = req.query;
    const filter = {};
    if (search) filter.$text = { $search: search };
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(filter)
        .select('-password -verificationToken -resetPasswordToken')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(filter)
    ]);

    res.json({ users, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/admin/users/:id ──
router.patch('/users/:id', requireRole('admin'), [
  body('role').optional().isIn(['researcher','reviewer','editor','admin']),
  body('isActive').optional().isBoolean(),
  body('isVerified').optional().isBoolean()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const allowed = ['role','isActive','isVerified'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true })
      .select('-password -verificationToken -resetPasswordToken');

    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user, message: 'User updated.' });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/admin/users/:id ──
router.delete('/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ error: 'Cannot delete your own account.' });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ message: 'User deactivated.' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/papers ──
router.get('/papers', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, department } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (department) filter.department = department;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [papers, total] = await Promise.all([
      Paper.find(filter)
        .populate('primaryAuthor', 'name institution email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Paper.countDocuments(filter)
    ]);

    res.json({ papers, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/admin/papers/:id/status ──
router.patch('/papers/:id/status', [
  body('status').isIn(['submitted','under_review','revision_required','accepted','rejected','published'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const updates = { status: req.body.status };
    if (req.body.status === 'published') updates.publishedAt = new Date();

    const paper = await Paper.findByIdAndUpdate(req.params.id, updates, { new: true })
      .populate('primaryAuthor', 'name email');

    if (!paper) return res.status(404).json({ error: 'Paper not found.' });
    res.json({ paper, message: 'Paper status updated.' });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/admin/papers/:id/feature ──
router.patch('/papers/:id/feature', async (req, res, next) => {
  try {
    const paper = await Paper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });
    paper.isFeatured = !paper.isFeatured;
    await paper.save();
    res.json({ isFeatured: paper.isFeatured });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/reviewers — List available reviewers ──
router.get('/reviewers', async (req, res, next) => {
  try {
    const { department } = req.query;
    const filter = { role: { $in: ['reviewer', 'editor'] }, isActive: true };
    if (department) filter.department = department;

    const reviewers = await User.find(filter)
      .select('name institution department email paperCount')
      .sort({ paperCount: -1 });

    res.json({ reviewers });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
