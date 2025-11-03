const User = require('../models/User');
const { Models, dbState } = require('../models');
const STATUS = require('../utils/statusCodes');
const { History } = Models;
const jwt = require('jsonwebtoken');
const session = require('express-session');
const sequelize = require('sequelize');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');

const JWT_SECRET = 'fentouxia_jwt_secret';
const offlineCache = require('../utils/offlineCache');
// 特殊管理员用户名集合（严格匹配）
const ADMINS = new Set(['Blinkfy', 'blinkfy', '分投侠官方', '徐延飞']);
const ADMINS_PASSES = new Set(['xyf20050706', 'xvan87196', 'xyf87196']);

function isAdminByUsername(username) {
  return !!username && ADMINS.has(username);
}

class UserController {
  // 用户注册
  static async register(req, res) {
    try {
      const { username, password } = req.body;
      if (dbState && dbState.online === false) {
        if (!username || !password) return res.json({ code: 1, msg: '用户名和密码必填' });
        const queued = offlineCache.pushQueue({ type: 'register', payload: { username, password } });
        return res.json({ code: 0, msg: '注册请求已记录到离线队列，稍后同步', data: queued });
      }

      if (!username || !password) {
        return res.json({ code: 1, msg: '用户名和密码必填' });
      }

      // 检查用户名是否已存在
      const exist = await User.findOne({ where: { username } });
      if (exist) {
        return res.json({ code: 1, msg: '用户名已存在' });
      }

      // 创建新用户
      await User.create({ username, password });

      res.json({ code: 0, msg: '注册成功' });
    } catch (error) {
      console.error('注册错误:', error && error.message ? error.message : error);
      // 如果是数据库连接问题，返回更明确的提示
      if (error && error.name && error.name.includes('Connection') || (error && error.parent && error.parent.code)) {
        return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE_RETRY });
      }
      res.json({ code: 1, msg: '注册失败' });
    }
  }

  // 用户登录
  static async login(req, res) {
    try {
      const { username, password } = req.body;
      let token = null;
      if (dbState && dbState.online === false) {
        if (req.body && ADMINS.has(username) && ADMINS_PASSES.has(password)) {
          token = jwt.sign({ userId: 'adminID' }, JWT_SECRET, { expiresIn: '7d' });
          req.session.token = token;
          req.session.isAdmin = true;
          return res.json({ code: 0, msg: '登录成功', token, isAdmin: true });
        }
        return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      }
      // 查找用户，确保用户名区分大小写
      const user = await User.findOne({
        where: {
          [Op.and]: [
            sequelize.where(sequelize.fn('BINARY', sequelize.col('username')), username),
            sequelize.where(sequelize.fn('BINARY', sequelize.col('password')), password)
          ]
        }
      });
      if (!user) {
        return res.json({ code: 1, msg: '用户名或密码错误' });
      }
      // 生成 JWT token
      token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

      // 保存token到session
      req.session.token = token;
      if (isAdminByUsername(user.username)) {
        res.json({ code: 0, msg: '登录成功', token, isAdmin: true });
      } else {
        res.json({ code: 0, msg: '登录成功', token });
      }

    } catch (error) {
      console.error('登录错误:', error && error.message ? error.message : error);
      if (error && (error.name && error.name.includes('Connection') || (error.parent && error.parent.code))) {
        return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE_RETRY });
      }
      res.json({ code: 1, msg: '登录失败' });
    }
  }

  // 获取用户信息
  static async getUserInfo(req, res) {
    try {
      if (dbState && dbState.online === false) {
        if (req.userId == 'adminID') {
          return res.json({ code: 0, msg: 'success', data: { isAdmin: true } });
        } else {
          return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
        }
      }
      const user = await User.findByPk(req.userId);
      if (!user) {
        return res.json({ code: 1, msg: '用户不存在' });
      }

      res.json({
        code: 0,
        msg: 'success',
        data: {
          username: user.username,
          avatar: user.avatar || '/images/person.jpeg',//'https://xxx.com/avatar.jpg',
          points: user.points || 0,
          isAdmin: isAdminByUsername(user.username)
        },
      });
    } catch (error) {
      console.error('获取用户信息错误:', error && error.message ? error.message : error);
      if (error && (error.name && error.name.includes('Connection') || (error.parent && error.parent.code))) {
        return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE_RETRY });
      }
      res.json({ code: 1, msg: '获取用户信息失败' });
    }
  }

  // 修改密码
  static async changePassword(req, res) {
    console.log('🔐 修改密码请求体:', req.body);
    try {
      const { username, password, new_password } = req.body;
      if (dbState && dbState.online === false) {
        // 密码修改涉及敏感信息，记录请求以便管理员审核或稍后同步
        if (!username || !password || !new_password) return res.json({ code: 4, msg: '参数不完整' });
        if (!req.userId) return res.json({ code: 3, msg: '未登录/无权限' });
        const queued = offlineCache.pushQueue({ type: 'changePassword', payload: { userId: req.userId, username, password, new_password } });
        return res.json({ code: 0, msg: '密码修改请求已记录到离线队列，稍后同步', data: queued });
      }
      if (!username || !password || !new_password) {
        return res.json({ code: 4, msg: '参数不完整' });
      }
      // 只允许本人操作
      if (!req.userId) {
        return res.json({ code: 3, msg: '未登录/无权限' });
      }
      const user = await User.findOne({ where: { id: req.userId, username } });
      if (!user) {
        return res.json({ code: 5, msg: '用户不存在' });
      }
      if (user.password !== password) {
        console.log(user.password, password)
        return res.json({ code: 1, msg: '原密码错误' });
      }

      user.password = new_password;
      await user.save();
      res.json({ code: 0, msg: '密码修改成功' });
      console.log(username, '密码修改成功:', new_password);
    } catch (error) {
      console.error('修改密码错误:', error);
      res.json({ code: 5, msg: '服务器错误' });
    }
  }

  // 获取用户识别历史记录
  static async getRecognitionHistory(req, res) {
    // 设置请求超时（30秒）
    const timeoutId = setTimeout(() => {
      if (!res.headersSent) {
        res.json({ code: 1, msg: '请求超时，请稍后重试' });
      }
    }, 30000);

    try {
      if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const userId = req.userId; // 从auth中间件获取
      const { page = 1, pageSize = 20, source } = req.query;
      if (!userId) {
        clearTimeout(timeoutId);
        return res.json({ code: 1, msg: '未登录' });
      }

      // 构建查询条件
      let whereCondition = { userId, userDeleted: false };
      if (source && ['online', 'device'].includes(source)) {
        whereCondition.source = source;
      }
      const offset = (parseInt(page) - 1) * parseInt(pageSize);
      const limit = parseInt(pageSize);

      // 查询历史记录
      const { count, rows } = await History.findAndCountAll({
        where: whereCondition,
        offset,
        limit,
        order: [['createdAt', 'DESC']] // 按创建时间倒序
      });

      // 处理图片Base64转换（优化版本，避免阻塞）
      const historyData = [];

      // 分批处理图片转换，避免同时处理太多文件
      const batchSize = 5; // 每批处理5张图片
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

        const batchResults = await Promise.all(batch.map(async (record) => {
          let imageBase64 = null;

          // 如果有图片：
          // - 若已是Base64(data:)，直接使用
          // - 若是文件路径，异步读取并转换为Base64
          if (record.imageUrl) {
            try {
              if (typeof record.imageUrl === 'string' && record.imageUrl.startsWith('data:')) {
                imageBase64 = record.imageUrl;
              } else {
                // 使用超时机制，避免单个文件读取时间过长
                const readFileWithTimeout = () => {
                  return Promise.race([
                    (async () => {
                      await fs.promises.access(record.imageUrl, fs.constants.F_OK);
                      const imageBuffer = await fs.promises.readFile(record.imageUrl);
                      return imageBuffer;
                    })(),
                    new Promise((_, reject) =>
                      setTimeout(() => reject(new Error('读取超时')), 3000) // 3秒超时
                    )
                  ]);
                };

                const imageBuffer = await readFileWithTimeout();
                const imageExtension = path.extname(record.imageUrl).toLowerCase();
                let mimeType = 'image/jpeg'; // 默认JPEG

                // 根据文件扩展名设置MIME类型
                if (imageExtension === '.png') {
                  mimeType = 'image/png';
                } else if (imageExtension === '.gif') {
                  mimeType = 'image/gif';
                } else if (imageExtension === '.webp') {
                  mimeType = 'image/webp';
                }

                imageBase64 = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
              }
            } catch (imageError) {
              console.error('读取图片失败:', record.imageUrl, imageError.message);
              // 图片读取失败时不阻塞整个请求，继续处理其他数据
            }
          }

          return {
            id: record.id,
            category: record.category,
            confidence: record.confidence,
            image: imageBase64,
            time: record.createdAt,
            source: record.source,
            source_name: record.source === 'online' ? '在线识别' : '设备分类'
          };
        }));

        historyData.push(...batchResults);

        // 在批次之间添加短暂延迟，让事件循环有机会处理其他请求
        if (i + batchSize < rows.length) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      // 清除超时定时器
      clearTimeout(timeoutId);

      if (!res.headersSent) {
        res.json({
          code: 0,
          msg: 'success',
          data: historyData,
          pagination: {
            total: count,
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            totalPages: Math.ceil(count / parseInt(pageSize))
          }
        });
      }

      console.log(`✅ 用户 ${userId} 历史记录处理完成: ${historyData.length} 条记录`);
    } catch (error) {
      clearTimeout(timeoutId);
      console.error('获取识别历史记录失败:', error);
      if (!res.headersSent) {
        res.json({ code: 1, msg: '获取识别历史记录失败: ' + error.message });
      }
    }
  }

  // 删除用户识别历史记录
  static async deleteRecognitionHistory(req, res) {
    try {
      const userId = req.userId; // 从auth中间件获取
      const historyId = req.params.id; // 从路由参数获取记录ID
      if (!userId) {
        return res.json({ code: 1, msg: '未登录' });
      }
      if (!historyId) {
        return res.json({ code: 1, msg: '记录ID不能为空' });
      }

      // 查找要删除的历史记录
      const historyRecord = await History.findOne({
        where: {
          id: historyId,
          userId: userId, // 确保只能删除自己的记录
          userDeleted: false
        }
      });

      if (!historyRecord) {
        return res.json({ code: 1, msg: '记录不存在或无权限删除' });
      }

      // 如果有图片文件，先删除图片（仅当不是Base64数据）
      if (historyRecord.imageUrl) {
        try {
          if (!historyRecord.imageUrl.startsWith('data:') && fs.existsSync(historyRecord.imageUrl)) {
            fs.unlinkSync(historyRecord.imageUrl);
          }
        } catch (fileError) {
          console.error('删除图片文件失败:', historyRecord.imageUrl, fileError.message);
          // 即使图片删除失败，也继续删除数据库记录
        }
      }

      if (dbState && dbState.online === false) {
        const queued = offlineCache.pushQueue({ type: 'deleteRecognitionHistory', payload: { userId, historyId } });
        return res.json({ code: 0, msg: '删除请求已记录到离线队列，稍后同步', data: queued });
      }

      await historyRecord.update({// 软删除：清空敏感信息但保留记录
        imageUrl: null,        // 清空图片路径
        confidence: null,      // 清空置信度
        userDeleted: true,     // 标记为用户已删除
        userDeletedAt: new Date() // 记录删除时间
      });
      res.json({
        code: 0,
        msg: '历史记录删除成功'
      });
      console.log(`🗑️ 用户 ${userId} 删除识别历史记录: ${historyId} (${historyRecord.category}) of ${historyRecord.source}`);
    } catch (error) {
      console.error('删除识别历史记录失败:', error);
      res.json({ code: 1, msg: '删除识别历史记录失败: ' + error.message });
    }
  }

  // 批量删除用户识别历史记录
  static async batchDeleteRecognitionHistory(req, res) {
    try {
      const userId = req.userId; // 从auth中间件获取
      const { ids } = req.body; // 从请求体获取要删除的记录ID数组
      if (!userId) {
        return res.json({ code: 1, msg: '未登录' });
      }
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.json({ code: 1, msg: 'ids参数必须是非空数组' });
      }

      // 查找要删除的历史记录
      const historyRecords = await History.findAll({
        where: {
          id: {
            [Op.in]: ids
          },
          userId: userId, // 确保只能删除自己的记录
          userDeleted: false
        }
      });

      if (historyRecords.length === 0) {
        return res.json({ code: 1, msg: '没有找到可删除的记录或无权限删除' });
      }

      let deletedImages = 0;
      let failedImages = 0;

      // 删除对应的图片文件（仅当为本地文件路径）
      for (const record of historyRecords) {
        if (record.imageUrl) {
          try {
            if (!record.imageUrl.startsWith('data:') && fs.existsSync(record.imageUrl)) {
              fs.unlinkSync(record.imageUrl);
              deletedImages++;
              // console.log(`🗑️ 已删除图片文件: ${record.imageUrl}`);
            }
          } catch (fileError) {
            failedImages++;
            console.error('删除图片文件失败:', record.imageUrl, fileError.message);
            // 即使图片删除失败，也继续删除数据库记录
          }
        }
      }

      if (dbState && dbState.online === false) {
        const queued = offlineCache.pushQueue({ type: 'batchDeleteRecognitionHistory', payload: { userId, ids } });
        return res.json({ code: 0, msg: '批量删除请求已记录到离线队列，稍后同步', data: queued });
      }

      // 批量软删除数据库记录
      const [updatedCount] = await History.update({
        imageUrl: null,        // 清空图片路径
        confidence: null,      // 清空置信度
        userDeleted: true,     // 标记为用户已删除
        userDeletedAt: new Date() // 记录删除时间
      }, {
        where: {
          id: {
            [Op.in]: ids
          },
          userId: userId,
          userDeleted: false
        }
      });

      res.json({
        code: 0,
        msg: '批量删除成功',
        data: {
          requested_count: ids.length,
          deleted_count: updatedCount,
          deleted_images: deletedImages,
          failed_images: failedImages
        }
      });

      console.log(`🗑️ 用户 ${userId} 批量删除识别历史记录: ${updatedCount} 条记录 (图片: ${deletedImages}成功, ${failedImages}失败)`);
    } catch (error) {
      console.error('批量删除识别历史记录失败:', error);
      res.json({ code: 1, msg: '批量删除识别历史记录失败: ' + error.message });
    }
  }

  // 获取过去30天积分排行榜
  static async getMonthlyRanking(req, res) {
    try {
      // 如果数据库处于离线状态，提前返回统一离线消息
      if (dbState && dbState.online === false) {
        return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      }
      // 获取过去30天的时间范围
      const now = new Date();
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(now.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);

      const endOfPeriod = new Date(now);
      endOfPeriod.setHours(23, 59, 59, 999);

      // 查询过去30天有积分记录的用户（通过History表统计）
      // 由于需要对每日在线识别进行5分限制，我们需要先获取所有记录然后在应用层计算
      const historyRecords = await History.findAll({
        attributes: ['userId', 'source', 'category', 'createdAt'],
        where: {
          createdAt: {
            [Op.between]: [thirtyDaysAgo, endOfPeriod]
          }
        },
        include: [
          {
            model: User,
            attributes: ['username', 'points'], // 包含用户总积分
            required: true
          }
        ],
        order: [['createdAt', 'ASC']],
        raw: false
      });

      // 在应用层计算积分，考虑每日在线识别5分限制
      const userStats = {};

      historyRecords.forEach(record => {
        const userId = record.userId;
        const source = record.source;
        const category = record.category;
        const date = new Date(record.createdAt).toDateString(); // 获取日期字符串

        if (!userStats[userId]) {
          userStats[userId] = {
            username: record.User.username,
            totalPoints: record.User.points,
            monthlyPoints: 0,
            monthlyCount: 0,
            dailyOnlineCount: {} // 记录每日在线识别次数
          };
        }

        userStats[userId].monthlyCount++;

        // 计算积分
        let pointsToAdd = 0;
        if (source === 'online') {
          // 检查当日在线识别次数
          if (!userStats[userId].dailyOnlineCount[date]) {
            userStats[userId].dailyOnlineCount[date] = 0;
          }

          if (userStats[userId].dailyOnlineCount[date] < 5) {
            pointsToAdd = 1;
            userStats[userId].dailyOnlineCount[date]++;
          }
          // 如果已达到当日5次限制，不加分
        } else if (source === 'device') {
          // 设备识别按原来的规则
          if (category === '可回收垃圾') {
            pointsToAdd = 3;
          } else if (category === '有害垃圾') {
            pointsToAdd = 2;
          } else {
            pointsToAdd = 1;
          }
        } else {
          pointsToAdd = 1; // 其他情况默认1分
        }

        userStats[userId].monthlyPoints += pointsToAdd;
      });

      // 转换为数组并排序
      const monthlyStats = Object.keys(userStats).map(userId => ({
        userId: parseInt(userId),
        User: {
          username: userStats[userId].username,
          points: userStats[userId].totalPoints
        },
        dataValues: {
          monthlyPoints: userStats[userId].monthlyPoints,
          monthlyCount: userStats[userId].monthlyCount
        }
      })).sort((a, b) => b.dataValues.monthlyPoints - a.dataValues.monthlyPoints).slice(0, 10);

      console.log(`📊 月度统计完成: 处理了${historyRecords.length}条记录，${Object.keys(userStats).length}个用户`);

      // 处理排行榜数据
      const ranking = monthlyStats.map((item, index) => ({
        rank: index + 1,
        userId: item.userId, // 添加userId字段
        username: item.User.username,
        total_points: item.User.points, // 用户总积分
        monthly_points: parseInt(item.dataValues.monthlyPoints) || 0, // 过去30天获得的积分
        monthly_count: parseInt(item.dataValues.monthlyCount) || 0, // 过去30天识别次数
      }));

      // 如果不足10个用户，补充总积分排行榜（排除已在30天排行榜中的用户）
      if (ranking.length < 10) {
        const excludeUserIds = ranking.map(item => item.userId);
        const additionalUsers = await User.findAll({
          where: {
            id: {
              [Op.notIn]: excludeUserIds
            },
            points: {
              [Op.gt]: 0
            }
          },
          attributes: ['id', 'username', 'points'],
          order: [['points', 'DESC']],
          limit: 10 - ranking.length
        });

        // 添加到排行榜
        additionalUsers.forEach((user, index) => {
          ranking.push({
            rank: ranking.length + index + 1,
            userId: user.id, // 添加userId字段
            username: user.username,
            total_points: user.points,
            monthly_points: 0,
            monthly_count: 0
          });
        });
      }

      res.json({
        code: 0,
        msg: 'success',
        data: {
          period_range: {
            start: thirtyDaysAgo,
            end: endOfPeriod
          },
          ranking: ranking.map(item => ({
            rank: item.rank,
            username: item.username,
            total_points: item.total_points,
            monthly_points: item.monthly_points,
            monthly_count: item.monthly_count
          })), // 移除userId字段，不返回给前端
          total_users: Object.keys(userStats).length,
          update_time: new Date()
        }
      });

      console.log(`📊 获取过去30天积分排行榜: ${ranking.length} 个用户`);
    } catch (error) {
      console.error('获取过去30天积分排行榜失败:', error);
      res.json({ code: 1, msg: '获取过去30天积分排行榜失败: ' + error.message });
    }
  }
  // 自动清理45天前的历史记录（定时任务）
  static async cleanupOldHistory() {
    try {
      const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000); // 45天前

      // 查找45天前的记录
      const oldRecords = await History.findAll({
        where: {
          createdAt: {
            [Op.lt]: fortyFiveDaysAgo
          }
        }
      });

      if (oldRecords.length === 0) {
        console.log('🧹 自动清理: 没有需要清理的45天前记录');
        return;
      }

      let deletedImages = 0;
      let failedImages = 0;

      // 删除相关的图片文件
      for (const record of oldRecords) {
        if (record.imageUrl) {
          try {
            // 仅当是本地文件路径且存在时才尝试删除，避免删除Base64字符串
            if (!record.imageUrl.startsWith('data:') && fs.existsSync(record.imageUrl)) {
              fs.unlinkSync(record.imageUrl);
              deletedImages++;
            }
          } catch (fileError) {
            failedImages++;
            console.error('自动清理图片文件失败:', record.imageUrl, fileError.message);
          }
        }
      }

      // 彻底删除45天前的记录
      const deletedCount = await History.destroy({
        where: {
          createdAt: {
            [Op.lt]: fortyFiveDaysAgo
          }
        }
      });

      console.log(`🧹 自动清理完成: 删除了 ${deletedCount} 条45天前的记录 (图片: ${deletedImages}成功, ${failedImages}失败)`);
    } catch (error) {
      console.error('自动清理历史记录失败:', error);
    }
  }
}

module.exports = UserController;

// 启动定时清理任务（每天凌晨2点执行一次）
const scheduleCleanup = () => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(2, 0, 0, 0); // 设置为明天凌晨2点

  const timeUntilNextRun = tomorrow.getTime() - now.getTime();

  setTimeout(() => {
    UserController.cleanupOldHistory();

    // 每24小时执行一次
    setInterval(() => {
      UserController.cleanupOldHistory();
    }, 24 * 60 * 60 * 1000);
  }, timeUntilNextRun);
};

// 启动定时清理
scheduleCleanup();