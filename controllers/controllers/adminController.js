const { Models, dbState } = require('../models');
const { Op } = require('sequelize');

const { User, Bin, UserDevice, History } = Models;

function ok(data, msg = 'success') { return { code: 0, msg, data }; }
function fail(msg = '失败') { return { code: 1, msg }; }

function parsePagination(query) {
  const page = Math.max(parseInt(query.page || '1', 10), 1);
  const pageSize = Math.max(Math.min(parseInt(query.pageSize || '20', 10), 100), 1);
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

function ensureDbOnline(res) {
  if (dbState && dbState.online === false) {
    res.status(200).json({ code: 1, msg: '数据库离线' });
    return false;
  }
  return true;
}

class AdminController {
  // Users
  static async listUsers(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const { offset, limit } = parsePagination(req.query);
      const where = {};
      if (req.query.keyword) {
        const kw = `%${req.query.keyword}%`;
        const orConds = [{ username: { [Op.like]: kw } }];
        const kid = parseInt(req.query.keyword, 10);
        if (Number.isFinite(kid)) orConds.push({ id: kid });
        where[Op.or] = orConds;
      }
      if (req.query.startDate || req.query.endDate) {
        where.createdAt = {};
        if (req.query.startDate) where.createdAt[Op.gte] = new Date(req.query.startDate);
        if (req.query.endDate) where.createdAt[Op.lte] = new Date(req.query.endDate);
      }
      const { count, rows } = await User.findAndCountAll({ where, offset, limit, order: [['createdAt', 'DESC']] });
      const ADMINS = new Set(['blinkfy','Blinkfy', '徐延飞','分投侠官方']);
      const list = rows.map(u => ({ id: u.id, username: u.username, points: u.points || 0, isAdmin: ADMINS.has(u.username), createdAt: u.createdAt, updatedAt: u.updatedAt, avatar: u.avatar || '' }));
      return res.json(ok({ total: count, list }));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async createUser(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const { username, password, avatar = '', points = 0 } = req.body || {};
      if (!username || !password) return res.json({ code: 1, msg: '参数验证失败' });
      const exist = await User.findOne({ where: { username } });
      if (exist) return res.json({ code: 1, msg: '用户名已存在' });
      const u = await User.create({ username, password, avatar, points });
      return res.json(ok({ id: u.id, username: u.username, avatar: u.avatar || '', points: u.points || 0, createdAt: u.createdAt }, '创建成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async updateUser(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const { username, password, avatar, points } = req.body || {};
      const u = await User.findByPk(id);
      if (!u) return res.json({ code: 1, msg: '资源不存在' });
      if (username !== undefined) u.username = username;
      if (password !== undefined) u.password = password;
      if (avatar !== undefined) u.avatar = avatar;
      if (points !== undefined) u.points = points;
      await u.save();
      return res.json(ok({ id: u.id, username: u.username, avatar: u.avatar || '', points: u.points || 0, updatedAt: u.updatedAt }, '更新成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async deleteUser(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const u = await User.findByPk(id);
      if (!u) return res.json({ code: 404, msg: '资源不存在' });
      await UserDevice.destroy({ where: { userId: id } });
      await History.destroy({ where: { userId: id } });
      await u.destroy();
      return res.json(ok(null, '删除成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  // Bins
  static async listBins(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const { offset, limit } = parsePagination(req.query);
      const where = {};
      if (req.query.status) where.status = req.query.status;
      if (req.query.type) where.type = req.query.type;
      if (req.query.review !== undefined) where.review = String(req.query.review) === 'true';
      // 支持 keyword: 在名称或描述中模糊搜索
      if (req.query.keyword) {
        const kw = `%${req.query.keyword}%`;
        const orConds = [
          { name: { [Op.like]: kw } },
          { describe: { [Op.like]: kw } }
        ];
        const kid = parseInt(req.query.keyword, 10);
        if (Number.isFinite(kid)) orConds.push({ id: kid });
        where[Op.or] = orConds;
      }
      if (req.query.startDate || req.query.endDate) {
        where.createdAt = {};
        if (req.query.startDate) where.createdAt[Op.gte] = new Date(req.query.startDate);
        if (req.query.endDate) where.createdAt[Op.lte] = new Date(req.query.endDate);
      }
      const scope = Bin.scope('withUnreviewed');
      const { count, rows } = await scope.findAndCountAll({ where, offset, limit, order: [['createdAt', 'DESC']] });
      return res.json(ok({ total: count, list: rows }));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async createBin(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const data = req.body || {};
      if (!data.name || !data.type) return res.json({ code: 1, msg: '参数验证失败' });
      const b = await Bin.create({
        name: data.name,
        describe: data.describe || '',
        type: data.type,
        imagePath: data.imagePath || '',
        latitude: data.latitude,
        longitude: data.longitude,
        review: data.review === true,
        status: data.status || 'offline',
        callback_url: data.callback_url || ''
      });
      return res.json(ok({ id: b.id, name: b.name, type: b.type, review: b.review, status: b.status, createdAt: b.createdAt }, '创建成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async updateBin(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const b = await Bin.scope('withUnreviewed').findByPk(id);
      if (!b) return res.json({ code: 1, msg: '资源不存在' });
      const data = req.body || {};
      ['name', 'describe', 'type', 'imagePath', 'latitude', 'longitude', 'review', 'status', 'callback_url'].forEach(k => {
        if (data[k] !== undefined) b[k] = data[k];
      });
      await b.save();
      return res.json(ok({ id: b.id, updatedAt: b.updatedAt }, '更新成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async deleteBin(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const b = await Bin.scope('withUnreviewed').findByPk(id);
      if (!b) return res.json({ code: 1, msg: '资源不存在' });
      await UserDevice.destroy({ where: { deviceId: id } });
      await b.destroy();
      return res.json(ok(null, '删除成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async approveBin(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const b = await Bin.scope('withUnreviewed').findByPk(id);
      if (!b) return res.json({ code: 1, msg: '资源不存在' });
      b.review = true; await b.save();
      return res.json(ok({ id: b.id, review: b.review, updatedAt: b.updatedAt }, '审核通过'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async rejectBin(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const b = await Bin.scope('withUnreviewed').findByPk(id);
      if (!b) return res.json({ code: 1, msg: '资源不存在' });
      b.review = false; await b.save();
      return res.json(ok({ id: b.id, review: b.review, updatedAt: b.updatedAt }, '审核拒绝'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async getBinErrorReports(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const b = await Bin.scope('withUnreviewed').findByPk(id);
      if (!b) return res.json({ code: 404, msg: '资源不存在' });
      const reports = Array.isArray(b.errorReport) ? b.errorReport : [];
      return res.json(ok(reports));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async clearBinErrorReports(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const b = await Bin.scope('withUnreviewed').findByPk(id);
      if (!b) return res.json({ code: 404, msg: '资源不存在' });
      b.errorReport = [];
      await b.save();
      return res.json(ok(null, '错误报告已清除'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  // UserDevice
  static async listUserDevices(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const { offset, limit } = parsePagination(req.query);
      const where = {};
      if (req.query.userId) where.userId = parseInt(req.query.userId, 10);
      if (req.query.deviceId) where.deviceId = parseInt(req.query.deviceId, 10);
      // 关键词：支持 userId/deviceId（数字）、用户名、设备名
      const include = [
        { model: User, attributes: ['id', 'username'], required: false },
        { model: Bin, attributes: ['id', 'name'], required: false }
      ];
      if (req.query.keyword) {
        const kw = `%${req.query.keyword}%`;
        const orConds = [
          { '$User.username$': { [Op.like]: kw } },
          { '$Bin.name$': { [Op.like]: kw } },
          { '$Bin.describe$': { [Op.like]: kw } }
        ];
        const kid = parseInt(req.query.keyword, 10);
        if (Number.isFinite(kid)) {
          orConds.push({ userId: kid });
          orConds.push({ deviceId: kid });
          orConds.push({ '$User.id$': kid });
          orConds.push({ '$Bin.id$': kid });
        }
        where[Op.or] = orConds;
      }
      if (req.query.startDate || req.query.endDate) {
        where.createdAt = {};
        if (req.query.startDate) where.lastActiveAt[Op.gte] = new Date(req.query.startDate);
        if (req.query.endDate) where.lastActiveAt[Op.lte] = new Date(req.query.endDate);
      }
      const { count, rows } = await UserDevice.findAndCountAll({
        where,
        include,
        distinct: true,
        subQuery: false,
        offset,
        limit,
        order: [['createdAt', 'DESC']]
      });
      const list = rows.map(r => ({
        userId: r.userId,
        deviceId: r.deviceId,
        username: r.User ? r.User.username : null,
        deviceName: r.Bin ? r.Bin.name : null,
        connectedAt: r.connectedAt,
        lastActiveAt: r.lastActiveAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      }));
      return res.json(ok({ total: count, list }));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async createUserDevice(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const { userId, deviceId } = req.body || {};
      const uid = userId !== undefined ? parseInt(userId, 10) : undefined;
      const did = deviceId !== undefined ? parseInt(deviceId, 10) : undefined;
      if (!Number.isFinite(uid) || !Number.isFinite(did)) return res.json({ code: 1, msg: '参数验证失败: userId/deviceId' });
      const u = await User.findByPk(uid);
      const b = await Bin.findByPk(did);
      if (!u || !b) return res.json({ code: 1, msg: '用户或设备不存在' });
      const now = new Date();
      // 幂等：如存在则仅刷新活跃时间
      const existed = await UserDevice.findOne({ where: { userId: uid, deviceId: did } });
      if (existed) {
        existed.lastActiveAt = now;
        if (!existed.connectedAt) existed.connectedAt = now;
        await existed.save();
        return res.json(ok(existed, '已存在，已刷新活跃时间'));
      }
      const ud = await UserDevice.create({ userId: uid, deviceId: did, connectedAt: now, lastActiveAt: now });
      return res.json(ok(ud, '创建成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async updateUserDevice(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      // 复合键：优先从路径获取，其次 body/query
      const uidRaw = (req.params && req.params.userId) ?? (req.body && req.body.userId) ?? (req.query && req.query.userId);
      const didRaw = (req.params && req.params.deviceId) ?? (req.body && req.body.deviceId) ?? (req.query && req.query.deviceId);
      const uid = parseInt(uidRaw, 10);
      const did = parseInt(didRaw, 10);
      if (!Number.isFinite(uid) || !Number.isFinite(did)) {
        return res.json({ code: 1, msg: '参数验证失败: 需要提供 userId 与 deviceId' });
      }
      const { lastActiveAt, connectedAt } = req.body || {};
      const ud = await UserDevice.findOne({ where: { userId: uid, deviceId: did } });
      if (!ud) return res.json({ code: 1, msg: '资源不存在' });
      if (lastActiveAt !== undefined) {
        const ts = new Date(lastActiveAt);
        if (isNaN(ts.getTime())) return res.json({ code: 1, msg: '参数验证失败: lastActiveAt' });
        ud.lastActiveAt = ts;
      }
      if (connectedAt !== undefined) {
        const cs = new Date(connectedAt);
        if (isNaN(cs.getTime())) return res.json({ code: 1, msg: '参数验证失败: connectedAt' });
        ud.connectedAt = cs;
      }
      await ud.save();
      return res.json(ok(ud, '更新成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async deleteUserDevice(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      // 复合键删除
      const uidRaw = (req.params && req.params.userId) ?? (req.body && req.body.userId) ?? (req.query && req.query.userId);
      const didRaw = (req.params && req.params.deviceId) ?? (req.body && req.body.deviceId) ?? (req.query && req.query.deviceId);
      const uid = parseInt(uidRaw, 10);
      const did = parseInt(didRaw, 10);
      if (!Number.isFinite(uid) || !Number.isFinite(did)) {
        return res.json({ code: 1, msg: '参数验证失败: 需要提供 userId 与 deviceId' });
      }
      const deleted = await UserDevice.destroy({ where: { userId: uid, deviceId: did } });
      if (!deleted) return res.json({ code: 1, msg: '资源不存在' });
      return res.json(ok(null, '删除成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  // History
  static async listHistory(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const { offset, limit } = parsePagination(req.query);
      const where = {};
      if (req.query.userId) where.userId = parseInt(req.query.userId, 10);
      if (req.query.category) where.category = req.query.category;
      if (req.query.source) where.source = req.query.source;
      if (req.query.userDeleted !== undefined) where.userDeleted = String(req.query.userDeleted) === 'true';
      // keyword: 支持 类别/用户名 模糊；数字时匹配记录ID、userId、用户ID
      const include = [{ model: User, attributes: ['id', 'username'], required: false }];
      if (req.query.keyword) {
        const kw = `%${req.query.keyword}%`;
        const orConds = [
          { category: { [Op.like]: kw } },
          { '$User.username$': { [Op.like]: kw } }
        ];
        const kid = parseInt(req.query.keyword, 10);
        if (Number.isFinite(kid)) {
          orConds.push({ id: kid });
          orConds.push({ userId: kid });
          orConds.push({ '$User.id$': kid });
        }
        where[Op.or] = orConds;
      }
      if (req.query.startDate || req.query.endDate) {
        where.createdAt = {};
        if (req.query.startDate) where.createdAt[Op.gte] = new Date(req.query.startDate);
        if (req.query.endDate) where.createdAt[Op.lte] = new Date(req.query.endDate);
      }
      const { count, rows } = await History.findAndCountAll({
        where,
        include,
        distinct: true,
        subQuery: false,
        offset,
        limit,
        order: [['createdAt', 'DESC']]
      });
      const list = rows.map(h => ({
        id: h.id,
        userId: h.userId,
        username: h.User ? h.User.username : null,
        category: h.category,
        imageUrl: h.imageUrl,
        confidence: h.confidence,
        source: h.source,
        userDeleted: h.userDeleted,
        userDeletedAt: h.userDeletedAt,
        createdAt: h.createdAt,
        updatedAt: h.updatedAt
      }));
      return res.json(ok({ total: count, list }));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async createHistory(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const { userId, category, imageUrl = null, confidence = null, source = 'online' } = req.body || {};
      const { normalizeCategory } = require('../utils/category');
      if (!userId || !category) return res.json({ code: 1, msg: '参数验证失败' });
      const u = await User.findByPk(userId);
      if (!u) return res.json({ code: 1, msg: '用户不存在' });
      const h = await History.create({ userId, category: normalizeCategory(category), imageUrl, confidence, source });
      return res.json(ok({ id: h.id, userId: h.userId, category: h.category, confidence: h.confidence, source: h.source, createdAt: h.createdAt }, '创建成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async updateHistory(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const h = await History.findByPk(id);
      if (!h) return res.json({ code: 1, msg: '资源不存在' });
      const { category, confidence, source, userDeleted, userDeletedAt, imageUrl } = req.body || {};
      if (category !== undefined) {
        const { normalizeCategory } = require('../utils/category');
        h.category = normalizeCategory(category);
      }
      if (imageUrl !== undefined) h.imageUrl = imageUrl;
      if (confidence !== undefined) h.confidence = confidence;
      if (source !== undefined) h.source = source;
      if (userDeleted !== undefined) h.userDeleted = !!userDeleted;
      if (userDeletedAt !== undefined) h.userDeletedAt = userDeletedAt ? new Date(userDeletedAt) : null;
      await h.save();
      return res.json(ok({ id: h.id, updatedAt: h.updatedAt }, '更新成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async deleteHistory(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const h = await History.findByPk(id);
      if (!h) return res.json({ code: 1, msg: '资源不存在' });
      await h.destroy();
      return res.json(ok(null, '删除成功（硬删除）'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  static async restoreHistory(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const id = parseInt(req.params.id, 10);
      const h = await History.findByPk(id);
      if (!h) return res.json({ code: 404, msg: '资源不存在' });
      h.userDeleted = false;
      h.userDeletedAt = null;
      await h.save();
      return res.json(ok({ id: h.id, userDeleted: h.userDeleted, userDeletedAt: h.userDeletedAt, updatedAt: h.updatedAt }, '恢复成功'));
    } catch (e) { return res.json(fail(e.message)); }
  }

  // Stats
  static async databaseStats(req, res) {
    try {
      if (!ensureDbOnline(res)) return;
      const usersCount = await User.count();
      const binsCount = await Bin.count();
      const userDevicesCount = await UserDevice.count();
      const historyCount = await History.count();
      return res.json(ok({ usersCount, binsCount, userDevicesCount, historyCount }));
    } catch (e) { return res.json(fail(e.message)); }
  }
}

module.exports = AdminController;
