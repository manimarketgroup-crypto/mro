const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { body, query, validationResult } = require('express-validator');
const Paper = require('../models/Paper');
const User = require('../models/User');
const { protect, requireRole, optionalAuth } = require('../middleware/auth');
const { upload, handleUploadError } = require('../middleware/upload');

// ── GET /api/papers — List / Search ──
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      department,
      status = 'published',
      sort = 'newest',
      search,
      author
    } = req.query;

    const filter = {};

    // Non-admins only see published papers (or their own)
    if (!req.user || !['admin', 'editor'].includes(req.user.role)) {
      if (author && req.user && req.user._id.toString() === author) {
        filter.primaryAuthor = author;
      } else {
        filter.status = 'published';
        filter.isPublic = true;
      }
    } else {
      if (status) filter.status = status;
    }

    if (department) filter.department = department;
    if (author && !filter.primaryAuthor) filter.primaryAuthor = author;

    if (search) {
      filter.$text = { $search: search };
    }

    const sortOptions = {
      newest:    { createdAt: -1 },
      oldest:    { createdAt: 1 },
      most_liked:{ likes: -1 },
      most_viewed: { views: -1 }
    };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [papers, total] = await Promise.all([
      Paper.find(filter)
        .populate('primaryAuthor', 'name institution department profilePhoto')
        .sort(sortOptions[sort] || sortOptions.newest)
        .skip(skip)
        .limit(parseInt(limit))
        .select('-assignedReviewers -editorDecision'),
      Paper.countDocuments(filter)
    ]);

    res.json({
      papers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/papers/trending ──
router.get('/trending', async (req, res, next) => {
  try {
    const { limit = 5 } = req.query;
    const papers = await Paper.find({ status: 'published', isPublic: true })
      .populate('primaryAuthor', 'name institution')
      .sort({ views: -1, createdAt: -1 })
      .limit(parseInt(limit))
      .select('title department views likes createdAt primaryAuthor');
    res.json({ papers });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/papers — Upload new paper ──
router.post('/', protect, upload.single('paper'), handleUploadError, [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 300 }),
  body('abstract').trim().notEmpty().withMessage('Abstract is required').isLength({ max: 3000 }),
  body('department').notEmpty().isIn(['cs_ai','space','medical_bio','mechanical','electrical','civil','environmental','aerospace','other']),
  body('keywords').optional()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ errors: errors.array() });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Paper file is required.' });
    }

    let keywords = [];
    if (req.body.keywords) {
      try {
        keywords = typeof req.body.keywords === 'string'
          ? JSON.parse(req.body.keywords)
          : req.body.keywords;
      } catch {
        keywords = req.body.keywords.split(',').map(k => k.trim()).filter(Boolean);
      }
    }

    let coAuthors = [];
    if (req.body.coAuthors) {
      try {
        coAuthors = JSON.parse(req.body.coAuthors);
      } catch { coAuthors = []; }
    }

    const paper = await Paper.create({
      title: req.body.title,
      abstract: req.body.abstract,
      keywords,
      department: req.body.department,
      primaryAuthor: req.user._id,
      coAuthors,
      fileUrl: `/uploads/${req.file.filename}`,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      fileType: req.file.mimetype,
      status: 'submitted'
    });

    await User.findByIdAndUpdate(req.user._id, { $inc: { paperCount: 1 } });

    const populated = await paper.populate('primaryAuthor', 'name institution');
    res.status(201).json({ paper: populated, message: 'Paper submitted successfully.' });
  } catch (err) {
    if (req.file) fs.unlinkSync(req.file.path);
    next(err);
  }
});

// ── GET /api/papers/:id ──
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const paper = await Paper.findById(req.params.id)
      .populate('primaryAuthor', 'name institution department bio profilePhoto')
      .populate('assignedReviewers.reviewer', 'name')
      .populate('editorDecision.editor', 'name');

    if (!paper) return res.status(404).json({ error: 'Paper not found.' });

    const isAuthor = req.user && paper.primaryAuthor._id.toString() === req.user._id.toString();
    const isPrivileged = req.user && ['admin', 'editor', 'reviewer'].includes(req.user.role);

    if (paper.status !== 'published' && !isAuthor && !isPrivileged) {
      return res.status(403).json({ error: 'This paper is not publicly available.' });
    }

    // Increment views
    await Paper.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });

    res.json({ paper });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/papers/:id ──
router.patch('/:id', protect, async (req, res, next) => {
  try {
    const paper = await Paper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });

    const isAuthor = paper.primaryAuthor.toString() === req.user._id.toString();
    const isPrivileged = ['admin', 'editor'].includes(req.user.role);

    if (!isAuthor && !isPrivileged) {
      return res.status(403).json({ error: 'Not authorized to edit this paper.' });
    }

    const allowed = ['title', 'abstract', 'keywords', 'coAuthors', 'journal', 'volume', 'issue', 'pages', 'doi'];
    if (isPrivileged) allowed.push('status', 'isFeatured', 'isPublic');

    allowed.forEach(field => {
      if (req.body[field] !== undefined) paper[field] = req.body[field];
    });

    if (isPrivileged && req.body.status === 'published' && !paper.publishedAt) {
      paper.publishedAt = new Date();
    }

    await paper.save();
    res.json({ paper, message: 'Paper updated.' });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/papers/:id ──
router.delete('/:id', protect, async (req, res, next) => {
  try {
    const paper = await Paper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });

    const isAuthor = paper.primaryAuthor.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';

    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to delete this paper.' });
    }

    // Delete file from disk
    const filePath = path.join(__dirname, '..', paper.fileUrl);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await paper.deleteOne();
    await User.findByIdAndUpdate(paper.primaryAuthor, { $inc: { paperCount: -1 } });

    res.json({ message: 'Paper deleted.' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/papers/:id/like ──
router.post('/:id/like', protect, async (req, res, next) => {
  try {
    const paper = await Paper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });

    const userId = req.user._id;
    const alreadyLiked = paper.likes.includes(userId);

    if (alreadyLiked) {
      paper.likes.pull(userId);
    } else {
      paper.likes.push(userId);
    }
    await paper.save();

    res.json({
      liked: !alreadyLiked,
      likeCount: paper.likes.length
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/papers/:id/save ──
router.post('/:id/save', protect, async (req, res, next) => {
  try {
    const paper = await Paper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });

    const user = req.user;
    const alreadySaved = user.savedPapers.includes(req.params.id);

    if (alreadySaved) {
      await User.findByIdAndUpdate(user._id, { $pull: { savedPapers: req.params.id } });
    } else {
      await User.findByIdAndUpdate(user._id, { $addToSet: { savedPapers: req.params.id } });
    }

    res.json({ saved: !alreadySaved });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/papers/:id/download ──
router.get('/:id/download', optionalAuth, async (req, res, next) => {
  try {
    const paper = await Paper.findById(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });
    if (paper.status !== 'published' && !req.user) {
      return res.status(403).json({ error: 'Login required to download.' });
    }

    const filePath = path.join(__dirname, '..', paper.fileUrl);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server.' });
    }

    await Paper.findByIdAndUpdate(req.params.id, { $inc: { downloads: 1 } });

    res.download(filePath, paper.fileName || 'paper.pdf');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
