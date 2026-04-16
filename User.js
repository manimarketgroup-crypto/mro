const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Comment = require('../models/Comment');
const { protect, requireRole, optionalAuth } = require('../middleware/auth');

// ── GET /api/comments/:paperId — Get comments for a paper ──
router.get('/:paperId', optionalAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const topLevel = await Comment.find({
      paper: req.params.paperId,
      parentComment: null,
      isDeleted: false
    })
      .populate('author', 'name institution profilePhoto role')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));

    // Fetch replies for each top-level comment
    const commentIds = topLevel.map(c => c._id);
    const replies = await Comment.find({
      parentComment: { $in: commentIds },
      isDeleted: false
    })
      .populate('author', 'name institution profilePhoto role')
      .sort({ createdAt: 1 });

    const repliesByParent = {};
    replies.forEach(r => {
      const pid = r.parentComment.toString();
      if (!repliesByParent[pid]) repliesByParent[pid] = [];
      repliesByParent[pid].push(r);
    });

    const threaded = topLevel.map(c => ({
      ...c.toJSON(),
      replies: repliesByParent[c._id.toString()] || []
    }));

    const total = await Comment.countDocuments({ paper: req.params.paperId, parentComment: null, isDeleted: false });

    res.json({ comments: threaded, total });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/comments — Add a comment ──
router.post('/', protect, [
  body('paperId').notEmpty().isMongoId(),
  body('content').trim().notEmpty().withMessage('Comment cannot be empty').isLength({ max: 2000 }),
  body('parentComment').optional().isMongoId()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const comment = await Comment.create({
      paper: req.body.paperId,
      author: req.user._id,
      content: req.body.content,
      parentComment: req.body.parentComment || null
    });

    const populated = await comment.populate('author', 'name institution profilePhoto role');
    res.status(201).json({ comment: populated });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/comments/:id — Edit a comment ──
router.patch('/:id', protect, [
  body('content').trim().notEmpty().isLength({ max: 2000 })
], async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    if (comment.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'You can only edit your own comments.' });
    }

    comment.content = req.body.content;
    comment.isEdited = true;
    await comment.save();
    res.json({ comment });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/comments/:id ──
router.delete('/:id', protect, async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });

    const isAuthor = comment.author.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    comment.isDeleted = true;
    comment.content = '[deleted]';
    await comment.save();
    res.json({ message: 'Comment deleted.' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/comments/:id/like ──
router.post('/:id/like', protect, async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });

    const liked = comment.likes.includes(req.user._id);
    if (liked) {
      comment.likes.pull(req.user._id);
    } else {
      comment.likes.push(req.user._id);
    }
    await comment.save();
    res.json({ liked: !liked, likeCount: comment.likes.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
