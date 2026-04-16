const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Review = require('../models/Review');
const Paper = require('../models/Paper');
const { protect, requireRole } = require('../middleware/auth');

// ── POST /api/reviews/assign — Editor assigns reviewer ──
router.post('/assign', protect, requireRole('editor', 'admin'), [
  body('paperId').notEmpty().isMongoId(),
  body('reviewerId').notEmpty().isMongoId(),
  body('dueDate').optional().isISO8601()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { paperId, reviewerId, dueDate } = req.body;

    const paper = await Paper.findById(paperId);
    if (!paper) return res.status(404).json({ error: 'Paper not found.' });

    const alreadyAssigned = paper.assignedReviewers.some(
      r => r.reviewer.toString() === reviewerId
    );
    if (alreadyAssigned) {
      return res.status(409).json({ error: 'Reviewer already assigned to this paper.' });
    }

    // Create review record
    const review = await Review.create({
      paper: paperId,
      reviewer: reviewerId,
      dueDate: dueDate ? new Date(dueDate) : undefined
    });

    // Update paper
    paper.assignedReviewers.push({ reviewer: reviewerId });
    if (paper.status === 'submitted') paper.status = 'under_review';
    await paper.save();

    res.status(201).json({ review, message: 'Reviewer assigned successfully.' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/reviews/my — Get reviews assigned to logged-in reviewer ──
router.get('/my', protect, requireRole('reviewer', 'editor', 'admin'), async (req, res, next) => {
  try {
    const reviews = await Review.find({ reviewer: req.user._id })
      .populate('paper', 'title department abstract status primaryAuthor createdAt')
      .populate('paper.primaryAuthor', 'name institution')
      .sort({ createdAt: -1 });
    res.json({ reviews });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/reviews/paper/:paperId — Get all reviews for a paper ──
router.get('/paper/:paperId', protect, requireRole('editor', 'admin'), async (req, res, next) => {
  try {
    const reviews = await Review.find({ paper: req.params.paperId })
      .populate('reviewer', 'name institution department')
      .sort({ createdAt: -1 });
    res.json({ reviews });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/reviews/:id — Get a single review ──
router.get('/:id', protect, async (req, res, next) => {
  try {
    const review = await Review.findById(req.params.id)
      .populate('paper', 'title department status')
      .populate('reviewer', 'name institution');

    if (!review) return res.status(404).json({ error: 'Review not found.' });

    const isReviewer = review.reviewer._id.toString() === req.user._id.toString();
    const isPrivileged = ['editor', 'admin'].includes(req.user.role);
    if (!isReviewer && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    res.json({ review });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/reviews/:id — Submit or update a review ──
router.patch('/:id', protect, requireRole('reviewer', 'editor', 'admin'), [
  body('scores.originality').optional().isInt({ min: 1, max: 10 }),
  body('scores.methodology').optional().isInt({ min: 1, max: 10 }),
  body('scores.clarity').optional().isInt({ min: 1, max: 10 }),
  body('scores.significance').optional().isInt({ min: 1, max: 10 }),
  body('scores.references').optional().isInt({ min: 1, max: 10 }),
  body('recommendation').optional().isIn(['accept','minor_revision','major_revision','reject','']),
  body('summary').optional().isLength({ max: 2000 }),
  body('strengthsComments').optional().isLength({ max: 2000 }),
  body('weaknessesComments').optional().isLength({ max: 2000 }),
  body('privateComments').optional().isLength({ max: 2000 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found.' });

    const isReviewer = review.reviewer.toString() === req.user._id.toString();
    const isPrivileged = ['editor', 'admin'].includes(req.user.role);
    if (!isReviewer && !isPrivileged) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (review.status === 'submitted' && !isPrivileged) {
      return res.status(400).json({ error: 'Review already submitted and cannot be edited.' });
    }

    const allowed = ['scores','summary','strengthsComments','weaknessesComments','privateComments','recommendation'];
    allowed.forEach(f => { if (req.body[f] !== undefined) review[f] = req.body[f]; });

    // Calculate overall score
    if (req.body.scores) {
      const vals = Object.values(review.scores).filter(v => v !== undefined);
      if (vals.length > 0) {
        review.overallScore = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
      }
    }

    // Submit
    if (req.body.submit === true) {
      review.status = 'submitted';
      review.submittedAt = new Date();
      // Update paper reviewer status
      await Paper.updateOne(
        { _id: review.paper, 'assignedReviewers.reviewer': review.reviewer },
        { $set: { 'assignedReviewers.$.status': 'completed' } }
      );
    } else {
      review.status = 'in_progress';
    }

    await review.save();
    res.json({ review, message: req.body.submit ? 'Review submitted.' : 'Review saved.' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/reviews/decision — Editor makes final decision ──
router.post('/decision', protect, requireRole('editor', 'admin'), [
  body('paperId').notEmpty().isMongoId(),
  body('decision').isIn(['accept', 'reject', 'revision']),
  body('comments').optional().isLength({ max: 2000 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { paperId, decision, comments } = req.body;

    const statusMap = {
      accept: 'accepted',
      reject: 'rejected',
      revision: 'revision_required'
    };

    const paper = await Paper.findByIdAndUpdate(paperId, {
      status: statusMap[decision],
      editorDecision: {
        editor: req.user._id,
        decision,
        comments: comments || '',
        decidedAt: new Date()
      },
      ...(decision === 'accept' && { publishedAt: new Date(), status: 'published' })
    }, { new: true }).populate('primaryAuthor', 'name email');

    if (!paper) return res.status(404).json({ error: 'Paper not found.' });

    res.json({ paper, message: `Paper ${decision}ed.` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
