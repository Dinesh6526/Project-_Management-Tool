require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { body, param, query, validationResult } = require('express-validator');
const { Server } = require('socket.io');
const { migrate } = require('./migrate');

const required = ['DB_HOST', 'DB_USER', 'DB_NAME', 'JWT_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

const app = express();
let io;

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 15,
  dateStrings: true
});

const AVATAR_COLORS = [
  '#6366f1', '#ec4899', '#8b5cf6', '#3b82f6', 
  '#10b981', '#f59e0b', '#06b6d4', '#14b8a6', 
  '#ef4444', '#f97316'
];

app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json({ limit: '500kb' }));

// Auth rate limiter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

// Helpers
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const handleErrors = (req, res) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    res.status(400).json({ error: result.array()[0].msg });
    return true;
  }
  return false;
};

const tokenFor = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
};

const auth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
};

const projectAccess = async (projectId, userId) => {
  const [rows] = await db.execute(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
    [projectId, userId]
  );
  return rows[0]?.role || null;
};

const notify = async (userId, message, link, projectId) => {
  try {
    const [r] = await db.execute(
      'INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)',
      [userId, message, link]
    );
    const notification = {
      id: r.insertId,
      user_id: userId,
      message,
      link,
      is_read: false,
      created_at: new Date().toISOString()
    };
    if (io) {
      io.to(`user:${userId}`).emit('notification', notification);
      if (projectId) {
        io.to(`project:${projectId}`).emit('project:changed', { projectId });
      }
    }
    return notification;
  } catch (err) {
    console.error('Failed to create notification:', err);
  }
};

// ==================== AUTH ROUTES ====================

app.post('/api/auth/register', authLimiter, [
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be between 2 and 80 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('password').isLength({ min: 6, max: 72 }).withMessage('Password must be at least 6 characters')
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const { name, email, password } = req.body;

  const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const hash = await bcrypt.hash(password, 12);
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  const [result] = await db.execute(
    'INSERT INTO users (name, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)',
    [name, email, hash, color]
  );

  const user = { id: result.insertId, name, email, avatar_color: color };
  res.status(201).json({ user, token: tokenFor(user) });
}));

app.post('/api/auth/login', authLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('password').isString().isLength({ min: 1, max: 72 }).withMessage('Password is required')
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const { email, password } = req.body;

  const [rows] = await db.execute(
    'SELECT id, name, email, password_hash, avatar_color FROM users WHERE email = ?',
    [email]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const userDto = {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar_color: user.avatar_color || '#6366f1'
  };
  res.json({ user: userDto, token: tokenFor(userDto) });
}));

app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const [rows] = await db.execute(
    'SELECT id, name, email, avatar_color, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: 'User not found.' });
  }
  res.json({ user: rows[0] });
}));

app.get('/api/users/search', auth, asyncRoute(async (req, res) => {
  const queryText = (req.query.q || '').trim();
  if (queryText.length < 1) {
    const [rows] = await db.execute(
      'SELECT id, name, email, avatar_color FROM users WHERE id != ? LIMIT 10',
      [req.user.id]
    );
    return res.json(rows);
  }
  const term = `%${queryText}%`;
  const [rows] = await db.execute(
    'SELECT id, name, email, avatar_color FROM users WHERE (name LIKE ? OR email LIKE ?) AND id != ? LIMIT 10',
    [term, term, req.user.id]
  );
  res.json(rows);
}));

// ==================== PROJECT ROUTES ====================

app.get('/api/projects', auth, asyncRoute(async (req, res) => {
  const [rows] = await db.execute(`
    SELECT 
      p.id, p.name, p.description, p.color, p.owner_id, p.created_at,
      pm.role,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
      (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS member_count
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id
    WHERE pm.user_id = ?
    ORDER BY p.created_at DESC
  `, [req.user.id]);

  res.json(rows);
}));

app.post('/api/projects', auth, [
  body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Project name must be between 2 and 120 characters'),
  body('description').optional({ checkFalsy: true }).trim().isLength({ max: 2000 }),
  body('color').optional().trim().isLength({ max: 30 })
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const { name, description = null, color = '#6366f1' } = req.body;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute(
      'INSERT INTO projects (name, description, color, owner_id) VALUES (?, ?, ?, ?)',
      [name, description, color, req.user.id]
    );
    const projectId = r.insertId;

    await conn.execute(
      "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')",
      [projectId, req.user.id]
    );
    await conn.commit();

    res.status(201).json({ id: projectId, name, description, color, role: 'owner' });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

app.get('/api/projects/:id', auth, [
  param('id').isInt()
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const projectId = Number(req.params.id);
  const role = await projectAccess(projectId, req.user.id);
  if (!role) {
    return res.status(403).json({ error: 'You are not a member of this project.' });
  }

  const [p] = await db.execute('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!p[0]) return res.status(404).json({ error: 'Project not found.' });

  const [members] = await db.execute(`
    SELECT u.id, u.name, u.email, u.avatar_color, pm.role, pm.joined_at
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ?
    ORDER BY CASE pm.role WHEN 'owner' THEN 1 ELSE 2 END, u.name ASC
  `, [projectId]);

  const [tasks] = await db.execute(`
    SELECT 
      t.id, t.project_id, t.title, t.description, t.status, t.priority,
      t.assignee_id, t.due_date, t.position, t.created_by, t.created_at, t.updated_at,
      u.name AS assignee_name, u.email AS assignee_email, u.avatar_color AS assignee_avatar_color,
      c.name AS creator_name,
      (SELECT COUNT(*) FROM comments cm WHERE cm.task_id = t.id) AS comment_count
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN users c ON c.id = t.created_by
    WHERE t.project_id = ?
    ORDER BY t.position ASC, t.created_at DESC
  `, [projectId]);

  res.json({
    ...p[0],
    user_role: role,
    members,
    tasks
  });
}));

app.patch('/api/projects/:id', auth, [
  param('id').isInt(),
  body('name').optional().trim().isLength({ min: 2, max: 120 }),
  body('description').optional().trim().isLength({ max: 2000 }),
  body('color').optional().trim().isLength({ max: 30 })
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const projectId = Number(req.params.id);
  const role = await projectAccess(projectId, req.user.id);
  if (role !== 'owner') {
    return res.status(403).json({ error: 'Only the project owner can edit project settings.' });
  }

  const fields = [];
  const values = [];
  if (req.body.name !== undefined) { fields.push('name = ?'); values.push(req.body.name); }
  if (req.body.description !== undefined) { fields.push('description = ?'); values.push(req.body.description); }
  if (req.body.color !== undefined) { fields.push('color = ?'); values.push(req.body.color); }

  if (!fields.length) return res.status(400).json({ error: 'No fields to update.' });

  values.push(projectId);
  await db.execute(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, values);

  if (io) {
    io.to(`project:${projectId}`).emit('project:changed', { projectId });
  }
  res.json({ message: 'Project updated.' });
}));

app.delete('/api/projects/:id', auth, [
  param('id').isInt()
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const projectId = Number(req.params.id);
  const role = await projectAccess(projectId, req.user.id);
  if (role !== 'owner') {
    return res.status(403).json({ error: 'Only the project owner can delete this project.' });
  }

  await db.execute('DELETE FROM projects WHERE id = ?', [projectId]);
  if (io) {
    io.to(`project:${projectId}`).emit('project:deleted', { projectId });
  }
  res.json({ message: 'Project deleted successfully.' });
}));

// Project Members
app.post('/api/projects/:id/members', auth, [
  param('id').isInt(),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required')
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const projectId = Number(req.params.id);
  const role = await projectAccess(projectId, req.user.id);
  if (role !== 'owner') {
    return res.status(403).json({ error: 'Only the project owner can add members.' });
  }

  const [users] = await db.execute('SELECT id, name, email FROM users WHERE email = ?', [req.body.email]);
  if (!users[0]) {
    return res.status(404).json({ error: 'No user registered with that email address.' });
  }

  const newMember = users[0];
  try {
    await db.execute(
      "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')",
      [projectId, newMember.id]
    );

    const [p] = await db.execute('SELECT name FROM projects WHERE id = ?', [projectId]);
    const projectName = p[0]?.name || 'a project';

    await notify(
      newMember.id,
      `You were added to project "${projectName}" by ${req.user.name || 'the owner'}.`,
      `/project/${projectId}`,
      projectId
    );

    if (io) {
      io.to(`project:${projectId}`).emit('project:changed', { projectId });
    }

    res.status(201).json({ message: 'Member added successfully.' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'This user is already a member of this project.' });
    }
    throw e;
  }
}));

app.delete('/api/projects/:id/members/:userId', auth, [
  param('id').isInt(),
  param('userId').isInt()
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const projectId = Number(req.params.id);
  const targetUserId = Number(req.params.userId);
  const role = await projectAccess(projectId, req.user.id);

  if (targetUserId !== req.user.id && role !== 'owner') {
    return res.status(403).json({ error: 'You do not have permission to remove this member.' });
  }

  // Prevent removing project owner
  const targetRole = await projectAccess(projectId, targetUserId);
  if (targetRole === 'owner') {
    return res.status(400).json({ error: 'The project owner cannot be removed.' });
  }

  await db.execute(
    'DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
    [projectId, targetUserId]
  );

  // Unassign tasks assigned to removed user
  await db.execute(
    'UPDATE tasks SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?',
    [projectId, targetUserId]
  );

  if (io) {
    io.to(`project:${projectId}`).emit('project:changed', { projectId });
  }

  res.json({ message: 'Member removed.' });
}));

// ==================== TASK ROUTES ====================

app.post('/api/projects/:id/tasks', auth, [
  param('id').isInt(),
  body('title').trim().isLength({ min: 1, max: 180 }).withMessage('Task title is required'),
  body('description').optional({ checkFalsy: true }).trim().isLength({ max: 5000 }),
  body('status').optional().isIn(['todo', 'in_progress', 'review', 'done']),
  body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  body('assigneeId').optional({ nullable: true }).isInt(),
  body('dueDate').optional({ nullable: true }).isISO8601()
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const projectId = Number(req.params.id);
  const role = await projectAccess(projectId, req.user.id);
  if (!role) {
    return res.status(403).json({ error: 'You are not a member of this project.' });
  }

  const title = (req.body.title || '').trim();
  const description = req.body.description && String(req.body.description).trim() ? String(req.body.description).trim() : null;
  const status = ['todo', 'in_progress', 'review', 'done'].includes(req.body.status) ? req.body.status : 'todo';
  const priority = ['low', 'medium', 'high', 'urgent'].includes(req.body.priority) ? req.body.priority : 'medium';
  const assigneeId = (req.body.assigneeId && Number(req.body.assigneeId)) ? Number(req.body.assigneeId) : null;
  const dueDate = (req.body.dueDate && String(req.body.dueDate).trim()) ? String(req.body.dueDate).trim().slice(0, 10) : null;

  if (assigneeId && !(await projectAccess(projectId, assigneeId))) {
    return res.status(400).json({ error: 'Assignee must be a member of this project.' });
  }

  // Calculate highest position in column
  const [posRows] = await db.execute(
    'SELECT COALESCE(MAX(position), 0) + 1 AS nextPos FROM tasks WHERE project_id = ? AND status = ?',
    [projectId, status]
  );
  const nextPos = posRows[0]?.nextPos || 1;

  const [r] = await db.execute(
    `INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, due_date, position, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, title, description, status, priority, assigneeId, dueDate, nextPos, req.user.id]
  );
  const taskId = r.insertId;

  if (assigneeId && assigneeId !== req.user.id) {
    await notify(
      assigneeId,
      `You were assigned a new task: "${title}" by ${req.user.name || 'a teammate'}`,
      `/project/${projectId}`,
      projectId
    );
  }

  if (io) {
    io.to(`project:${projectId}`).emit('project:changed', { projectId, taskId, action: 'task_created' });
  }

  res.status(201).json({ id: taskId, message: 'Task created successfully.' });
}));

app.get('/api/tasks/:id', auth, [
  param('id').isInt()
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const taskId = Number(req.params.id);

  const [rows] = await db.execute(`
    SELECT t.*, 
      u.name AS assignee_name, u.email AS assignee_email, u.avatar_color AS assignee_avatar_color,
      c.name AS creator_name, c.email AS creator_email
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN users c ON c.id = t.created_by
    WHERE t.id = ?
  `, [taskId]);

  const task = rows[0];
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  if (!(await projectAccess(task.project_id, req.user.id))) {
    return res.status(403).json({ error: 'You do not have access to this task.' });
  }

  const [comments] = await db.execute(`
    SELECT cm.id, cm.task_id, cm.user_id, cm.content, cm.created_at,
           u.name AS user_name, u.email AS user_email, u.avatar_color AS user_avatar_color
    FROM comments cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.task_id = ?
    ORDER BY cm.created_at ASC
  `, [taskId]);

  res.json({ ...task, comments });
}));

app.patch('/api/tasks/:id', auth, [
  param('id').isInt(),
  body('title').optional().trim().isLength({ min: 1, max: 180 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 5000 }),
  body('status').optional().isIn(['todo', 'in_progress', 'review', 'done']),
  body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  body('assigneeId').optional({ nullable: true }),
  body('dueDate').optional({ nullable: true }),
  body('position').optional().isInt()
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const taskId = Number(req.params.id);

  const [rows] = await db.execute(
    'SELECT id, project_id, assignee_id, title, status FROM tasks WHERE id = ?',
    [taskId]
  );
  const task = rows[0];
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  if (!(await projectAccess(task.project_id, req.user.id))) {
    return res.status(403).json({ error: 'No project access.' });
  }

  const allowedCols = {
    title: 'title',
    description: 'description',
    status: 'status',
    priority: 'priority',
    assigneeId: 'assignee_id',
    dueDate: 'due_date',
    position: 'position'
  };

  const fields = [];
  const values = [];

  for (const [key, col] of Object.entries(allowedCols)) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      let val = req.body[key];
      if (key === 'assigneeId') {
        val = (val && Number(val)) ? Number(val) : null;
        if (val && !(await projectAccess(task.project_id, val))) {
          return res.status(400).json({ error: 'Assignee must be a project member.' });
        }
      }
      if (key === 'dueDate') {
        val = (val && String(val).trim()) ? String(val).trim().slice(0, 10) : null;
      }
      if (key === 'description') {
        val = (val && String(val).trim()) ? String(val).trim() : null;
      }
      fields.push(`${col} = ?`);
      values.push(val);
    }
  }

  if (!fields.length) {
    return res.status(400).json({ error: 'No valid fields provided for update.' });
  }

  values.push(taskId);
  await db.execute(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, values);

  // If assignee changed, notify new assignee
  if (Object.prototype.hasOwnProperty.call(req.body, 'assigneeId')) {
    const newAssigneeId = req.body.assigneeId ? Number(req.body.assigneeId) : null;
    if (newAssigneeId && newAssigneeId !== task.assignee_id && newAssigneeId !== req.user.id) {
      await notify(
        newAssigneeId,
        `You were assigned to: "${task.title}"`,
        `/project/${task.project_id}`,
        task.project_id
      );
    }
  }

  if (io) {
    io.to(`project:${task.project_id}`).emit('project:changed', {
      projectId: task.project_id,
      taskId,
      action: 'task_updated',
      updates: req.body
    });
  }

  res.json({ message: 'Task updated successfully.' });
}));

app.delete('/api/tasks/:id', auth, [
  param('id').isInt()
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const taskId = Number(req.params.id);

  const [rows] = await db.execute('SELECT project_id, title FROM tasks WHERE id = ?', [taskId]);
  const task = rows[0];
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  if (!(await projectAccess(task.project_id, req.user.id))) {
    return res.status(403).json({ error: 'No project access.' });
  }

  await db.execute('DELETE FROM tasks WHERE id = ?', [taskId]);

  if (io) {
    io.to(`project:${task.project_id}`).emit('project:changed', {
      projectId: task.project_id,
      taskId,
      action: 'task_deleted'
    });
  }

  res.json({ message: 'Task deleted successfully.' });
}));

// ==================== COMMENTS ROUTES ====================

app.get('/api/tasks/:id/comments', auth, [
  param('id').isInt()
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const taskId = Number(req.params.id);

  const [task] = await db.execute('SELECT project_id FROM tasks WHERE id = ?', [taskId]);
  if (!task[0]) return res.status(404).json({ error: 'Task not found.' });

  if (!(await projectAccess(task[0].project_id, req.user.id))) {
    return res.status(403).json({ error: 'No project access.' });
  }

  const [comments] = await db.execute(`
    SELECT cm.id, cm.task_id, cm.user_id, cm.content, cm.created_at,
           u.name AS user_name, u.email AS user_email, u.avatar_color AS user_avatar_color
    FROM comments cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.task_id = ?
    ORDER BY cm.created_at ASC
  `, [taskId]);

  res.json(comments);
}));

app.post('/api/tasks/:id/comments', auth, [
  param('id').isInt(),
  body('content').trim().isLength({ min: 1, max: 3000 }).withMessage('Comment content cannot be empty')
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  const taskId = Number(req.params.id);

  const [taskRows] = await db.execute(
    'SELECT project_id, title, created_by, assignee_id FROM tasks WHERE id = ?',
    [taskId]
  );
  const task = taskRows[0];
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  if (!(await projectAccess(task.project_id, req.user.id))) {
    return res.status(403).json({ error: 'No project access.' });
  }

  const [r] = await db.execute(
    'INSERT INTO comments (task_id, user_id, content) VALUES (?, ?, ?)',
    [taskId, req.user.id, req.body.content]
  );

  const commentId = r.insertId;

  const [userRow] = await db.execute('SELECT name, email, avatar_color FROM users WHERE id = ?', [req.user.id]);
  const newComment = {
    id: commentId,
    task_id: taskId,
    user_id: req.user.id,
    content: req.body.content,
    created_at: new Date().toISOString(),
    user_name: userRow[0]?.name || req.user.name,
    user_email: userRow[0]?.email || req.user.email,
    user_avatar_color: userRow[0]?.avatar_color || '#6366f1'
  };

  // Notify creator and assignee if different from commenter
  const notifyIds = new Set([task.created_by, task.assignee_id]);
  for (const uid of notifyIds) {
    if (uid && uid !== req.user.id) {
      await notify(
        uid,
        `${newComment.user_name} commented on: "${task.title}"`,
        `/project/${task.project_id}`,
        task.project_id
      );
    }
  }

  if (io) {
    io.to(`project:${task.project_id}`).emit('comment:new', {
      projectId: task.project_id,
      taskId,
      comment: newComment
    });
    io.to(`project:${task.project_id}`).emit('project:changed', {
      projectId: task.project_id,
      taskId,
      action: 'comment_added'
    });
  }

  res.status(201).json(newComment);
}));

// ==================== NOTIFICATIONS ROUTES ====================

app.get('/api/notifications', auth, asyncRoute(async (req, res) => {
  const [rows] = await db.execute(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json(rows);
}));

app.patch('/api/notifications/:id/read', auth, [
  param('id').isInt()
], asyncRoute(async (req, res) => {
  if (handleErrors(req, res)) return;
  await db.execute(
    'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  res.json({ message: 'Notification marked as read.' });
}));

app.post('/api/notifications/mark-all-read', auth, asyncRoute(async (req, res) => {
  await db.execute(
    'UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE',
    [req.user.id]
  );
  res.json({ message: 'All notifications marked as read.' });
}));

app.delete('/api/notifications/clear', auth, asyncRoute(async (req, res) => {
  await db.execute(
    'DELETE FROM notifications WHERE user_id = ? AND is_read = TRUE',
    [req.user.id]
  );
  res.json({ message: 'Read notifications cleared.' });
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Central Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ error: 'An unexpected internal error occurred. Please try again.' });
});

// ==================== START SERVER ====================

const startServer = async (port) => {
  try {
    await migrate();
  } catch (err) {
    console.warn('Initial migration warning:', err.message);
  }

  const server = http.createServer(app);
  io = new Server(server, {
    cors: { origin: process.env.CLIENT_ORIGIN || '*' }
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Unauthorized'));
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch (err) {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);

    socket.on('project:join', async (projectId) => {
      if (projectId && (await projectAccess(projectId, socket.user.id))) {
        socket.join(`project:${projectId}`);
      }
    });

    socket.on('project:leave', (projectId) => {
      socket.leave(`project:${projectId}`);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is in use. Retrying on port ${nextPort}...`);
      startServer(nextPort);
      return;
    }
    console.error('Server failed to start:', err);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`ProjectFlow backend running at http://localhost:${port}`);
  });
};

startServer(Number(process.env.PORT || 3000));
