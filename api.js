const mongoose = require('mongoose');

const paperSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: [300, 'Title cannot exceed 300 characters']
  },
  abstract: {
    type: String,
    required: [true, 'Abstract is required'],
    maxlength: [3000, 'Abstract cannot exceed 3000 characters']
  },
  keywords: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  department: {
    type: String,
    required: [true, 'Department is required'],
    enum: ['cs_ai', 'space', 'medical_bio', 'mechanical', 'electrical', 'civil', 'environmental', 'aerospace', 'other']
  },

  // Authors
  primaryAuthor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  coAuthors: [{
    name: { type: String, trim: true },
    institution: { type: String, trim: true },
    email: { type: String, trim: true }
  }],

  // File
  fileUrl: {
    type: String,
    required: [true, 'Paper file is required']
  },
  fileName: String,
  fileSize: Number,
  fileType: {
    type: String,
    enum: ['application/pdf', 'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  },

  // Status workflow
  status: {
    type: String,
    enum: ['submitted', 'under_review', 'revision_required', 'accepted', 'rejected', 'published'],
    default: 'submitted'
  },

  // Review assignment
  assignedReviewers: [{
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' }
  }],
  editorDecision: {
    editor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decision: { type: String, enum: ['accept', 'reject', 'revision', ''], default: '' },
    comments: String,
    decidedAt: Date
  },

  // Social metrics
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  views: { type: Number, default: 0 },
  downloads: { type: Number, default: 0 },
  citations: { type: Number, default: 0 },

  // Metadata
  doi: { type: String, default: '' },
  publishedAt: Date,
  journal: { type: String, default: '' },
  volume: { type: String, default: '' },
  issue: { type: String, default: '' },
  pages: { type: String, default: '' },

  isPublic: { type: Boolean, default: true },
  isFeatured: { type: Boolean, default: false },

  // Plagiarism
  plagiarismScore: { type: Number, default: null },
  plagiarismCheckedAt: Date
}, {
  timestamps: true
});

// ── Indexes ──
paperSchema.index({ title: 'text', abstract: 'text', keywords: 'text' });
paperSchema.index({ department: 1, status: 1, createdAt: -1 });
paperSchema.index({ primaryAuthor: 1, createdAt: -1 });
paperSchema.index({ views: -1, createdAt: -1 });
paperSchema.index({ likes: 1 });

// ── Virtual: like count ──
paperSchema.virtual('likeCount').get(function() {
  return this.likes ? this.likes.length : 0;
});

paperSchema.set('toJSON', { virtuals: true });
paperSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Paper', paperSchema);
