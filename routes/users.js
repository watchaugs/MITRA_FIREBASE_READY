/**
 * routes/users.js — User access management
 *
 * Security fixes applied here:
 *   - C2: error.stack never leaves the server
 *   - C3: no DDL (ALTER TABLE) runs on user actions
 *   - C4: role-elevation check on create / update
 *   - H8: bulk-delete refuses to delete self or last master_admin
 *   - H9: password policy enforced via passwordPolicyError()
 *   - H15: user creation wrapped in transaction
 *   - C1: removed plaintext credential email flow; new users get a reset link
 */

'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { query, pool } = require('../db');
const { authenticate, requirePerm, canGrantRole, invalidateUserCache } = require('../middleware/auth');
const { passwordPolicyError, sendResetEmail } = require('./auth');
const { audit } = require('../lib/auditLogger');
const log = require('../lib/logger');

router.use(authenticate);

const ALLOWED_ROLES = new Set([
  'master_admin', 'admin', 'superadmin',
  'education_secretary', 'dept_education',
  'district_officer', 'district',
  'developer', 'data_manager',
  'teacher', 'content_manager', 'content',
  'upload_authority', 'analytics_only',
  'viewer', 'view_only',
]);

const PROFILE_COLUMNS = `
  id, full_name, email, role, assigned_state, assigned_district,
  is_active, last_login_at, created_at,
  perm_publish_apps, perm_upload_unity, perm_manage_geo,
  perm_view_analytics, perm_create_users, perm_edit_curriculum,
  perm_approve_content, perm_export_data, perm_manage_ads, perm_replay_analytics
`;

// ── GET /api/users ───────────────────────────────────────────────────────────
router.get('/', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const { role, state, search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const where = [];
    const filterParams = [];
    if (role && ALLOWED_ROLES.has(role)) {
      filterParams.push(role);
      where.push(`role = $${filterParams.length}`);
    }
    if (state && typeof state === 'string' && state.length <= 100) {
      filterParams.push(state);
      where.push(`assigned_state = $${filterParams.length}`);
    }
    if (search && typeof search === 'string' && search.length <= 100) {
      filterParams.push(`%${search.replace(/[%_]/g, '\\$&')}%`);
      const i = filterParams.length;
      where.push(`(full_name ILIKE $${i} OR email ILIKE $${i})`);
    }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const listParams = [...filterParams, limit, offset];
    const result = await query(
      `SELECT ${PROFILE_COLUMNS}
       FROM users ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const countRes = await query(
      `SELECT COUNT(*)::int AS c FROM users ${whereClause}`,
      filterParams
    );

    res.json({ users: result.rows, total: countRes.rows[0].c, page, limit });
  } catch (err) {
    log.error({ err: err.message }, 'list users error');
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// GET /api/users/me — Get current authenticated user's profile
router.get('/me', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, full_name, email, role, assigned_state, assigned_district,
              is_active, perm_publish_apps, perm_upload_unity, perm_manage_geo,
              perm_view_analytics, perm_create_users, perm_edit_curriculum,
              perm_approve_content, perm_export_data, perm_manage_ads,
              perm_replay_analytics, perm_view_dashboard, perm_view_curriculum,
              perm_view_controls, perm_view_ar_assets, perm_view_notif,
              perm_view_users, perm_view_legal, perm_view_settings,
              perm_delete_users, perm_manage_compliance, perm_view_app_builder,
              mfa_enforced, last_login_at, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    
    if (!result.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('[users/me]', err);
    res.status(500).json({ error: 'Failed to fetch user', details: err.message });
  }
});

// ── POST /api/users — create user (sends reset link, never password) ─────────
router.post('/', requirePerm('perm_create_users'), async (req, res) => {
  const client = await pool.connect();
  try {
    // --- TRANSLATION ENGINE (New UI -> Old DB) ---
    if (req.body.permissions) {
      const p = req.body.permissions;
      req.body.perm_manage_geo = p.geofence;
      req.body.perm_create_users = p.users;
      req.body.perm_edit_curriculum = p.ar_curriculum;
      req.body.perm_upload_unity = p.ar_curriculum;
      req.body.perm_view_analytics = p.analytics;
      req.body.perm_publish_apps = p.notifications;
      
      // Global Read-Only Override
      if (p.readonly) {
        req.body.perm_manage_geo = false;
        req.body.perm_create_users = false;
        req.body.perm_edit_curriculum = false;
        req.body.perm_upload_unity = false;
        req.body.perm_publish_apps = false;
        req.body.perm_view_analytics = true;
      }
    }
    // ----------------------------------------------

    const {
      full_name, email, role = 'viewer',
      assigned_state = 'All India', assigned_district,
      perm_publish_apps = false, perm_upload_unity = false,
      perm_manage_geo = false, perm_view_analytics = false,
      perm_create_users = false, perm_edit_curriculum = false,
      perm_approve_content = false, perm_export_data = false,
      perm_manage_ads = false, perm_replay_analytics = false,
    } = req.body || {};

    if (!full_name || typeof full_name !== 'string' || full_name.length > 150) {
      return res.status(400).json({ error: 'full_name required' });
    }
    if (!email || typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email required' });
    }
    if (!ALLOWED_ROLES.has(role)) {
      return res.status(400).json({ error: 'invalid role' });
    }
    if (!canGrantRole(req.user.role, role)) {
      return res.status(403).json({ error: 'You cannot grant this role.' });
    }

    await client.query('BEGIN');

    const id = uuidv4();
    const tempPassword = crypto.randomBytes(24).toString('base64');
    const hash = await bcrypt.hash(tempPassword, 12);

    const result = await client.query(
      `INSERT INTO users (
         id, full_name, email, password_hash, role,
         assigned_state, assigned_district,
         perm_publish_apps, perm_upload_unity, perm_manage_geo,
         perm_view_analytics, perm_create_users, perm_edit_curriculum,
         perm_approve_content, perm_export_data, perm_manage_ads, perm_replay_analytics,
         is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true)
       ON CONFLICT (email) DO NOTHING
       RETURNING ${PROFILE_COLUMNS}`,
      [
        id, full_name, email.toLowerCase().trim(), hash, role,
        assigned_state, assigned_district || null,
        !!perm_publish_apps, !!perm_upload_unity, !!perm_manage_geo,
        !!perm_view_analytics, !!perm_create_users, !!perm_edit_curriculum,
        !!perm_approve_content, !!perm_export_data, !!perm_manage_ads, !!perm_replay_analytics,
      ]
    );

    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email already in use' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetHash  = crypto.createHash('sha256').update(resetToken).digest('hex');
    await client.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '48 hours', NOW())`,
      [uuidv4(), id, resetHash]
    );

    await client.query('COMMIT');

    const link = `${process.env.PUBLIC_URL || 'https://dashboard.mitra.gov.in'}/reset?token=${resetToken}`;
    sendResetEmail({ to: email.toLowerCase().trim(), name: full_name, link })
      .catch(e => log.error({ err: e.message }, 'sendResetEmail failed'));

    audit({
      userId: req.user.id, action: 'user.create', resourceType: 'user', resourceId: id,
      ip: req.ip, details: { email: email.toLowerCase().trim(), role },
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* */ }
    log.error({ err: err.message }, 'create user error');
    res.status(500).json({ error: 'Failed to create user' });
  } finally {
    client.release();
  }
});

// ── POST /api/users/bulk-update ──────────────────────────────────────────────
// NO DDL HERE (C3). Role is now a CHECK-constrained VARCHAR from the start.
router.post('/bulk-update', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const { ids, role, is_active } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No user IDs provided' });
    }
    if (ids.length > 1000) return res.status(400).json({ error: 'Too many IDs (max 1000)' });

    if (role !== undefined) {
      if (!ALLOWED_ROLES.has(role)) return res.status(400).json({ error: 'invalid role' });
      if (!canGrantRole(req.user.role, role)) return res.status(403).json({ error: 'You cannot grant this role.' });
    }

    const sets = [];
    const params = [];
    if (role !== undefined) { params.push(role); sets.push(`role = $${params.length}`); }
    if (is_active !== undefined) { params.push(!!is_active); sets.push(`is_active = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(ids);
    const result = await query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id::text = ANY($${params.length}::text[])
       RETURNING id`,
      params
    );

    result.rows.forEach(r => invalidateUserCache(r.id));
    audit({ userId: req.user.id, action: 'user.bulk_update', resourceType: 'user', ip: req.ip, details: { count: result.rowCount, role, is_active } });
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    log.error({ err: err.message }, 'bulk update error');
    res.status(500).json({ error: 'Bulk update failed' });
  }
});

// ── DELETE /api/users/bulk-delete — H8 safety net ────────────────────────────
router.delete('/bulk-delete', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No user IDs provided' });
    }
    if (ids.length > 100) return res.status(400).json({ error: 'Too many IDs (max 100)' });

    // 1. Never delete yourself
    if (ids.includes(req.user.id)) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }

    // 2. Never delete the last active master_admin
    const masterAdminsAfter = await query(
      `SELECT COUNT(*)::int AS c FROM users
       WHERE role = 'master_admin' AND is_active = true
       AND id::text != ALL($1::text[])`,
      [ids]
    );
    if (masterAdminsAfter.rows[0].c === 0) {
      return res.status(400).json({ error: 'Cannot delete the last active master admin.' });
    }

    const result = await query(
      `DELETE FROM users WHERE id::text = ANY($1::text[]) RETURNING id, email`,
      [ids]
    );

    result.rows.forEach(r => invalidateUserCache(r.id));
    audit({
      userId: req.user.id, action: 'user.bulk_delete', resourceType: 'user',
      ip: req.ip, details: { count: result.rowCount, deleted_emails: result.rows.map(r => r.email) },
    });
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    log.error({ err: err.message }, 'bulk delete error');
    res.status(500).json({ error: 'Bulk delete failed' });
  }
});

// ── GET /api/users/:id ──────────────────────────────────────────────────────
router.get('/:id', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const result = await query(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    log.error({ err: err.message }, 'get user error');
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── PUT /api/users/:id — C4 role-elevation check ────────────────────────────
// 1. EDIT USER (PUT)
// ==========================================
router.put('/:id', requirePerm('perm_create_users'), async (req, res) => {
  try {
    // --- TRANSLATION ENGINE (New UI -> Old DB) ---
    if (req.body.permissions) {
      const p = req.body.permissions;
      if (p.geofence !== undefined) req.body.perm_manage_geo = p.geofence;
      if (p.users !== undefined) req.body.perm_create_users = p.users;
      if (p.ar_curriculum !== undefined) {
        req.body.perm_edit_curriculum = p.ar_curriculum;
        req.body.perm_upload_unity = p.ar_curriculum; // Grants both AR permissions
      }
      if (p.analytics !== undefined) req.body.perm_view_analytics = p.analytics;
      if (p.notifications !== undefined) req.body.perm_publish_apps = p.notifications;

      // Global Read-Only Override
      if (p.readonly) {
        req.body.perm_manage_geo = false;
        req.body.perm_create_users = false;
        req.body.perm_edit_curriculum = false;
        req.body.perm_upload_unity = false;
        req.body.perm_publish_apps = false;
        req.body.perm_view_analytics = true; // Guests can view, but not touch
      }
    }
    // ----------------------------------------------

    const allowed = [
      'full_name', 'role', 'assigned_state', 'assigned_district', 'is_active',
      'perm_publish_apps', 'perm_upload_unity', 'perm_manage_geo',
      'perm_view_analytics', 'perm_create_users', 'perm_edit_curriculum',
      'perm_approve_content', 'perm_export_data', 'perm_manage_ads', 'perm_replay_analytics',
    ];
    const updates = [];
    const params = [];
    for (const field of allowed) {
      if (req.body[field] === undefined) continue;

      // Role-elevation guard
      if (field === 'role') {
        if (!ALLOWED_ROLES.has(req.body.role)) {
          return res.status(400).json({ error: 'invalid role' });
        }
        if (!canGrantRole(req.user.role, req.body.role)) {
          return res.status(403).json({ error: 'You cannot grant this role.' });
        }
      }

      let value = req.body[field];
      if (field.startsWith('perm_') || field === 'is_active') value = !!value;
      if (typeof value === 'string' && value.length > 200) {
        return res.status(400).json({ error: `${field} too long` });
      }
      params.push(value);
      updates.push(`${field} = $${params.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields' });

    // Block self-demotion / self-deactivation
    if (req.params.id === req.user.id && (req.body.is_active === false || (req.body.role && req.body.role !== req.user.role))) {
      return res.status(400).json({ error: 'You cannot change your own role or active state via this endpoint.' });
    }

    params.push(req.params.id);
    const result = await query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING ${PROFILE_COLUMNS}`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    invalidateUserCache(req.params.id);
    audit({ userId: req.user.id, action: 'user.update', resourceType: 'user', resourceId: req.params.id, ip: req.ip, details: { fields: Object.keys(req.body) } });
    res.json(result.rows[0]);
  } catch (err) {
    log.error({ err: err.message }, 'update user error');
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ── DELETE /api/users/:id ────────────────────────────────────────────────────
router.delete('/:id', requirePerm('perm_create_users'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    const remaining = await query(
      `SELECT COUNT(*)::int AS c FROM users WHERE role = 'master_admin' AND is_active = true AND id != $1`,
      [req.params.id]
    );
    if (remaining.rows[0].c === 0) {
      return res.status(400).json({ error: 'Cannot delete the last active master admin.' });
    }

    const result = await query(
      `DELETE FROM users WHERE id = $1 RETURNING id, email`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    invalidateUserCache(req.params.id);
    audit({ userId: req.user.id, action: 'user.delete', resourceType: 'user', resourceId: req.params.id, ip: req.ip, details: { email: result.rows[0].email } });
    res.json({ success: true, message: `User permanently deleted (DPDP §12).`, deleted_id: result.rows[0].id });
  } catch (err) {
    log.error({ err: err.message }, 'delete user error');
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ── POST /api/users/:id/reset-password ───────────────────────────────────────
// Triggers a reset-link email — no admin ever sets passwords directly.
router.post('/:id/reset-password', requirePerm('perm_create_users'), async (req, res) => {
  try {
    const userRes = await query('SELECT email, full_name FROM users WHERE id = $1', [req.params.id]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    await query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour', NOW())`,
      [uuidv4(), req.params.id, resetHash]
    );

    const link = `${process.env.PUBLIC_URL || 'https://dashboard.mitra.gov.in'}/reset?token=${resetToken}`;
    sendResetEmail({ to: userRes.rows[0].email, name: userRes.rows[0].full_name, link })
      .catch(e => log.error({ err: e.message }, 'sendResetEmail failed'));

    audit({ userId: req.user.id, action: 'user.password_reset_triggered', resourceType: 'user', resourceId: req.params.id, ip: req.ip });
    res.json({ message: 'Password reset link sent to the user.' });
  } catch (err) {
    log.error({ err: err.message }, 'admin reset-password error');
    res.status(500).json({ error: 'Could not trigger reset' });
  }
});


router.post('/bulk-import', async (req, res) => {
  const users = req.body.users;
  if (!users || !Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ error: 'No user data provided.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertQuery = `INSERT INTO users (name, email, role, state, district, school_id) VALUES ($1, $2, $3, $4, $5, $6)`;
    for (const user of users) {
      await client.query(insertQuery, [user.name, user.email, user.role || 'student', user.state, user.district, user.school_id]);
    }
    await client.query('COMMIT');
    res.status(200).json({ message: 'Users imported successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Database error.' });
  } finally {
    client.release();
  }
});


module.exports = router;
