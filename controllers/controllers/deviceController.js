const { Models, dbState } = require('../models');
const { Bin, UserDevice } = Models;
const STATUS = require('../utils/statusCodes');
const crypto = require('crypto');
const axios = require('axios');
const offlineCache = require('../utils/offlineCache');

class DeviceController {
  // 设备上线通知
  static async deviceOnline(req, res) {
    try {
      const { device_id } = req.params; // 改为device_id，对应Bin表的id
      const { timestamp, callback_url, token, token_expires_at } = req.body;

      if (dbState && dbState.online === false) {
        if (!device_id) return res.json({ code: 1, msg: 'device_id 不能为空' });
        const payload = { device_id, timestamp, callback_url, token, token_expires_at };
        const queued = offlineCache.pushQueue({ type: 'deviceOnline', payload });
        return res.json({ code: 0, msg: '设备上线信息已记录到离线队列，稍后同步', data: queued });
      }

      if (!device_id) {
        return res.json({ code: 1, msg: 'device_id 不能为空' });
      }

      // 查找垃圾桶设备记录（使用withUnreviewed作用域以便查找未审核的设备）
      let bin = await Bin.scope('withUnreviewed').findByPk(device_id);
      
      if (!bin) {
        return res.json({ code: 1, msg: '设备不存在，请确认设备ID正确' });
      }

      // 更新设备状态
      bin.status = 'online';
      bin.last_online_at = new Date();
      if (callback_url) bin.callback_url = callback_url;
      
      // 接受设备端提供的token
      if (token) {
        bin.token = token;
        bin.token_expires_at = token_expires_at ? new Date(token_expires_at) : new Date(Date.now() + 5 * 60 * 1000);
        console.log(`🔑 设备提供token: ${token.substring(0, 8)}... (过期时间: ${bin.token_expires_at})`);
      }
      
      await bin.save();
      
      console.log(`📱 设备上线: ${bin.name} (ID: ${device_id})`);

      res.json({
        code: 0,
        msg: '设备上线成功',
        data: {
          device_id: bin.id,
          device_name: bin.name,
          token: bin.token,
          expires_at: bin.token_expires_at,
          status: bin.status,
          token_source: token ? 'device' : 'none'
        }
      });
    } catch (error) {
      console.error('设备上线失败:', error);
      res.json({ code: 1, msg: '设备上线失败: ' + error.message });
    }
  }

  // 设备同步token（设备每5分钟调用一次）
  static async getDeviceToken(req, res) {
    try {
      const { device_id } = req.params;
      const { token, token_expires_at } = req.body; // 改为POST请求，接受设备端的token

      if (dbState && dbState.online === false) {
        if (!device_id) return res.json({ code: 1, msg: 'device_id 不能为空' });
        const queued = offlineCache.pushQueue({ type: 'syncToken', payload: { device_id, token, token_expires_at } });
        return res.json({ code: 0, msg: 'token 已记录到离线队列，稍后同步', data: queued });
      }

      const bin = await Bin.scope('withUnreviewed').findByPk(device_id);
      if (!bin) {
        return res.json({ code: 1, msg: '设备不存在' });
      }

      // 接受设备端提供的新token
      if (token) {
        bin.token = token;
        bin.token_expires_at = token_expires_at ? new Date(token_expires_at) : new Date(Date.now() + 5 * 60 * 1000);
        await bin.save();

        console.log(`🔄 设备同步token: ${bin.name} (ID: ${device_id}) -> ${token.substring(0, 8)}...`);
        
        // 后端只负责接收和存储，不主动通知设备
        // 设备自己负责定时刷新token，无需后端干预
      } else {
        console.log(`📄 设备请求当前token: ${bin.name} (ID: ${device_id})`);
      }

      res.json({
        code: 0,
        msg: 'success',
        data: {
          device_id: bin.id,
          device_name: bin.name,
        }
      });
    } catch (error) {
      console.error('设备token同步失败:', error);
      res.json({ code: 1, msg: 'token同步失败: ' + error.message });
    }
  }

  // 更新设备位置
  static async updateLocation(req, res) {
    try {
      const { device_id } = req.params;
      const { latitude, longitude, timestamp } = req.body;

      if (dbState && dbState.online === false) {
        if (!device_id) return res.json({ code: 1, msg: 'device_id 不能为空' });
        if (latitude === undefined || longitude === undefined) return res.json({ code: 1, msg: '经纬度信息不能为空' });
        const queued = offlineCache.pushQueue({ type: 'updateLocation', payload: { device_id, latitude, longitude, timestamp } });
        return res.json({ code: 0, msg: '位置信息已记录到离线队列，稍后同步', data: queued });
      }

      if (!device_id) {
        return res.json({ code: 1, msg: 'device_id 不能为空' });
      }

      if (latitude === undefined || longitude === undefined) {
        return res.json({ code: 1, msg: '经纬度信息不能为空' });
      }

      const bin = await Bin.scope('withUnreviewed').findByPk(device_id);
      if (!bin) {
        return res.json({ code: 1, msg: '设备不存在，请先上线' });
      }

      // 更新位置
      bin.latitude = parseFloat(latitude);
      bin.longitude = parseFloat(longitude);
      bin.last_location_update = new Date();
      bin.status = 'online'; // 有位置更新说明设备在线
      await bin.save();

      // console.log(`📍 设备位置更新: ${bin.name} (ID: ${device_id}) -> (${latitude}, ${longitude})`);

      res.json({
        code: 0,
        msg: '位置更新成功',
        data: {
          device_id: bin.id,
          device_name: bin.name,
          latitude: bin.latitude,
          longitude: bin.longitude,
          updated_at: bin.last_location_update
        }
      });
    } catch (error) {
      console.error('位置更新失败:', error);
      res.json({ code: 1, msg: '位置更新失败: ' + error.message });
    }
  }

  // 设备轮询查询用户连接状态
  static async getDeviceMessages(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const { device_id } = req.params;
      if (!device_id) {
        return res.json({ code: 1, msg: 'device_id 不能为空' });
      }
      // 查找设备是否存在
      const bin = await Bin.scope('withUnreviewed').findByPk(device_id);
      if (!bin) {
        return res.json({ code: 1, msg: '设备不存在' });
      }

      // 查询当前连接到该设备的用户
      const userDevice = await UserDevice.findOne({
        where: {
          deviceId: device_id
        },
        include: [
          {
            model: Models.User,
            as: 'User',
            attributes: ['id', 'username', 'points']
          }
        ],
        order: [['connectedAt', 'DESC']] // 按连接时间倒序，获取最新连接的用户
      });

      let responseData = {
        device_name: bin.name,
        has_user: false,
        user: null
      };

      if (userDevice) {
        responseData.has_user = true;
        responseData.user = {
          id: userDevice.userId,
          username: userDevice.User ? userDevice.User.username : '未知用户',
          points: userDevice.User ? userDevice.User.points : 0,
          connected_at: userDevice.connectedAt,
          last_active_at: userDevice.lastActiveAt
        };
        // console.log(`📡 设备 ${bin.name} 轮询: 用户 ${responseData.user.username} 正在使用设备`);
      } else {
        // console.log(`📡 设备 ${bin.name} 轮询: 当前无用户连接`);
      }
      res.json({
        code: 0,
        msg: 'success',
        data: responseData
      });
    } catch (error) {
      console.error('设备消息轮询失败:', error);
      res.json({ code: 1, msg: '设备消息轮询失败: ' + error.message });
    }
  }

  // 设备分类结果记录
  static async recordDeviceClassification(req, res) {
    try {
      const { device_id } = req.params;
      const { category, confidence, image_Base64 } = req.body;
  const { normalizeCategory } = require('../utils/category');

      if (dbState && dbState.online === false) {
        if (!device_id || !category || confidence === undefined) return res.json({ code: 1, msg: '缺少必要参数: device_id, category, confidence' });
        const queued = offlineCache.pushQueue({ type: 'recordClassification', payload: { device_id, category, confidence, image_Base64 } });
        return res.json({ code: 0, msg: '分类记录已写入离线队列，稍后同步', data: queued });
      }

      if (!device_id || !category || confidence === undefined) {
        return res.json({ code: 1, msg: '缺少必要参数: device_id, category, confidence' });
      }

      // 查找设备是否存在
      const bin = await Bin.scope('withUnreviewed').findByPk(device_id);
      if (!bin) {
        return res.json({ code: 1, msg: '设备不存在' });
      }

      // 查找当前连接到该设备的用户
      const userDevice = await UserDevice.findOne({
        where: {
          deviceId: device_id
        },
        include: [
          {
            model: Models.User,
            as: 'User',
            attributes: ['id', 'username']
          }
        ]
      });

      if (!userDevice) {
        return res.json({ code: 1, msg: '当前没有用户连接到该设备' });
      }
      
      // 与在线识别保持一致：直接将Base64（含data:image/...前缀）存入数据库
      let imageDataUrl = null;
      if (image_Base64 && typeof image_Base64 === 'string') {
        try {
          const hasPrefix = /^data:image\//i.test(image_Base64);
          imageDataUrl = hasPrefix ? image_Base64 : `data:image/jpeg;base64,${image_Base64.replace(/^data:image\/[a-z]+;base64,/, '')}`;
        } catch (e) {
          console.warn('⚠️ 处理设备图片Base64出错，将不保存图片:', e.message);
          imageDataUrl = null;
        }
      }

      // 创建设备分类记录
      const history = await Models.History.create({
        userId: userDevice.userId,
        imageUrl: imageDataUrl,
        category: normalizeCategory(category),
        confidence: parseFloat(confidence),
        source: 'device' // 设备分类
      });

      // 更新UserDevice表的最后活跃时间
      userDevice.lastActiveAt = new Date();
      await userDevice.save();

      // 更新用户积分 - 直接操作Users表
      const user = await Models.User.findByPk(userDevice.userId);
      if (user) {
        let pointsToAdd = 1;
        const finalCat = normalizeCategory(category);
        if(finalCat=='可回收垃圾'){pointsToAdd=3;}
        else if(finalCat=='有害垃圾'){pointsToAdd=2;}
        user.points += pointsToAdd; // 设备分类成功奖励1分
        await user.save();
        console.log(`🎉 用户 ${user.username} 的${finalCat}(置信度:${confidence})获得${pointsToAdd}积分，当前积分:${user.points}-from ${bin.name}`);
      }

      res.json({
        code: 0,
        msg: '分类记录创建成功'
      });
    } catch (error) {
      console.error('设备分类记录失败:', error);
      res.json({ code: 1, msg: '设备分类记录失败: ' + error.message });
    }
  }

  // 获取所有设备列表（管理员用）
  static async getDeviceList(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const { page = 1, pageSize = 20, status } = req.query;
      
      let whereCondition = {};
      if (status) {
        whereCondition.status = status;
      }

      const offset = (parseInt(page) - 1) * parseInt(pageSize);
      const limit = parseInt(pageSize);

      const { count, rows } = await Bin.scope('withUnreviewed').findAndCountAll({
        where: whereCondition,
        offset,
        limit,
        order: [['last_online_at', 'DESC']]
      });

      res.json({
        code: 0,
        msg: 'success',
        data: rows.map(bin => ({
          id: bin.id,
          name: bin.name,
          latitude: bin.latitude,
          longitude: bin.longitude,
          status: bin.status,
          token_expires_at: bin.token_expires_at,
          last_online_at: bin.last_online_at,
          last_location_update: bin.last_location_update,
          review: bin.review,
          createdAt: bin.createdAt
        })),
        pagination: {
          total: count,
          page: parseInt(page),
          pageSize: parseInt(pageSize),
          totalPages: Math.ceil(count / parseInt(pageSize))
        }
      });
    } catch (error) {
      console.error('获取设备列表失败:', error);
      res.json({ code: 1, msg: '获取设备列表失败: ' + error.message });
    }
  }

  // 用户扫码连接设备（前端调用）
  static async connectDevice(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const { device_id, token } = req.body;
      const userId = req.userId; // 从auth中间件获取

      if (!device_id || !token) {
        return res.json({ code: 1, msg: 'device_id和token不能为空' });
      }

      const bin = await Bin.scope('withUnreviewed').findByPk(device_id);
      if (!bin) {
        return res.json({ code: 1, msg: '设备不存在' });
      }

      // 验证token
      if (bin.token !== token) {
        return res.json({ code: 1, msg: 'token无效或已过期' });
      }

      // // 检查token是否过期
      if (bin.token_expires_at && new Date() > bin.token_expires_at) {
        return res.json({ code: 1, msg: 'token已过期，请重新扫码' });
      }

      // 删除用户和设备之前的所有连接记录
      await UserDevice.destroy({
        where: {
          userId
        }
      });
      await UserDevice.destroy({
        where: {
          deviceId: device_id
        }
      });
      // 创建新的用户设备关联记录
      const userDevice = await UserDevice.create({
        userId,
        deviceId: device_id,
        connectedAt: new Date(),
        lastActiveAt: new Date()
      });

      const user = await Models.User.findByPk(userId);

      res.json({
        code: 0,
        msg: '连接成功',
        data: {
          device_name: bin.name,
          connection_id: userDevice.id
        }
      });

      console.log(`🔗 用户 ${userId}:${user ? user.username : '未知用户'} 已连接到设备 ${bin.name} (ID: ${device_id})`);
    } catch (error) {
      console.error('连接设备失败:', error);
      res.json({ code: 1, msg: '连接设备失败: ' + error.message });
    }
  }
  static async disconnectDevice(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const userId = req.userId; // 从auth中间件获取
      const device_id = req.body['device_id']; // 可选，断开指定设备连接
      let deletedCount;
      let deviceName = '未知设备';
      
      if (device_id) {// 断开指定设备连接 - 直接删除记录
        const userDevice = await UserDevice.findOne({
          where: {
            userId,
            deviceId: device_id
          },
          include: [
            {
              model: Bin,
              as: 'Bin',
              attributes: ['name']
            }
          ]
        });

        if (!userDevice) {
          return res.json({ code: 1, msg: '未找到该设备的连接记录' });
        }

        deviceName = userDevice.Bin ? userDevice.Bin.name : `设备${device_id}`;
        deletedCount = await UserDevice.destroy({
          where: {
            userId,
            deviceId: device_id
          }
        });
      } else {// 断开用户的所有设备连接 - 删除所有记录
        deletedCount = await UserDevice.destroy({
          where: {
            userId
          }
        });
        if (deletedCount === 0) {
          return res.json({ code: 1, msg: '用户当前没有连接任何设备' });
        }
        deviceName = `${deletedCount}个设备`;
      }

      const user = await Models.User.findByPk(userId);
      res.json({
        code: 0,
        msg: '已断开连接',
        data: {
          device_id: device_id || 'all',
          device_name: deviceName,
          disconnected_at: new Date(),
          deleted_connections: deletedCount
        }
      });

      console.log(`🔌 用户 ${userId}:${user?user.username:'未知用户'} 断开 ${deviceName} 的连接`);
    } catch (error) {
      console.error('断开设备连接失败:', error);
      res.json({ code: 1, msg: '断开设备连接失败: ' + error.message });
    }
  }

  // 通知设备（调用设备回调接口）
  static async notifyDevice(callbackUrl, data) {
    try {
      await axios.post(callbackUrl + '/notify', data, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('✅ 设备通知发送成功:', callbackUrl);
    } catch (error) {
      console.log('⚠️ 设备通知发送失败:', error.message);
    }
  }

  // 获取用户当前连接的设备列表
  static async getUserConnectedDevices(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const userId = req.userId; // 从auth中间件获取
      const userDevices = await UserDevice.findAll({
        where: {
          userId
        },
        include: [
          {
            model: Bin,
            as: 'Bin',
            attributes: ['id', 'name', 'type', 'latitude', 'longitude', 'status', 'last_online_at']
          }
        ],
        order: [['connectedAt', 'DESC']]
      });

      const devices = userDevices.map(userDevice => ({
        device_id: userDevice.deviceId,
        device_name: userDevice.Bin ? userDevice.Bin.name : '未知设备',
        device_location: userDevice.Bin ? {
          latitude: userDevice.Bin.latitude,
          longitude: userDevice.Bin.longitude
        } : null,
        connected_at: userDevice.connectedAt,
        last_active_at: userDevice.lastActiveAt
      }));
      //查询用户积分
      const user = await Models.User.findByPk(userId);
      res.json({
        code: 0,
        msg: 'success',
        data: devices,
        points: user ? user.points : null
      });
    } catch (error) {
      console.error('获取用户连接设备失败:', error);
      res.json({ code: 1, msg: '获取用户连接设备失败: ' + error.message });
    }
  }

  // 设备端断开所有用户连接
  static async disconnectAllUsers(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const { device_id } = req.params;
      if (!device_id) {
        return res.json({ code: 1, msg: 'device_id 不能为空' });
      }
      // 查找设备是否存在
      const bin = await Bin.scope('withUnreviewed').findByPk(device_id);
      if (!bin) {
        return res.json({ code: 1, msg: '设备不存在' });
      }

      // 查找所有连接到该设备的用户
      const userDevices = await UserDevice.findAll({
        where: {
          deviceId: device_id
        },
        include: [
          {
            model: Models.User,
            as: 'User',
            attributes: ['id', 'username']
          }
        ]
      });
      if (userDevices.length === 0) {
        return res.json({
          code: 0,
          msg: '该设备当前没有用户连接',
          data: {
            device_id: parseInt(device_id),
            device_name: bin.name,
            disconnected_users: 0,
            disconnected_at: new Date()
          }
        });
      }

      // 删除所有连接记录
      const deletedCount = await UserDevice.destroy({
        where: {
          deviceId: device_id
        }
      });

      // 记录断开连接的用户信息
      const disconnectedUsers = userDevices.map(userDevice => ({
        user_id: userDevice.userId,
        username: userDevice.User ? userDevice.User.username : '未知用户',
        connected_at: userDevice.connectedAt,
        last_active_at: userDevice.lastActiveAt
      }));

      console.log(`🔌 设备 ${bin.name} (ID: ${device_id}) 断开了所有用户连接 (${deletedCount}个用户)`);
      disconnectedUsers.forEach(user => {
        console.log(`   - 用户: ${user.username} (ID: ${user.user_id})`);
      });

      res.json({
        code: 0,
        msg: '已断开所有用户连接',
        data: {
          device_id: parseInt(device_id),
          device_name: bin.name,
          disconnected_users: deletedCount,
          disconnected_at: new Date(),
          user_list: disconnectedUsers
        }
      });
    } catch (error) {
      console.error('设备断开所有用户连接失败:', error);
      res.json({ code: 1, msg: '设备断开所有用户连接失败: ' + error.message });
    }
  }

  // 清理不活跃的用户连接（定时任务）
  static async cleanupInactiveConnections() {
    try {
  if (dbState && dbState.online === false) return; // DB 离线时跳过清理任务
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000); // 5分钟前的时间
      // 查找所有5分钟内没有活跃的用户连接
      const inactiveConnections = await UserDevice.findAll({
        where: {
          lastActiveAt: {
            [require('sequelize').Op.lt]: fiveMinutesAgo
          }
        },
        include: [
          {
            model: Models.User,
            as: 'User',
            attributes: ['id', 'username']
          },
          {
            model: Bin,
            as: 'Bin',
            attributes: ['id', 'name']
          }
        ]
      });

      if (inactiveConnections.length > 0) {
        // 删除不活跃的连接
        const deletedCount = await UserDevice.destroy({
          where: {
            lastActiveAt: {
              [require('sequelize').Op.lt]: fiveMinutesAgo
            }
          }
        });

        console.log(`🧹 清理不活跃连接: ${deletedCount} 个连接已断开`);
        inactiveConnections.forEach(connection => {
          const username = connection.User ? connection.User.username : '未知用户';
          const deviceName = connection.Bin ? connection.Bin.name : '未知设备';
          console.log(`   - 用户: ${username} -> 设备: ${deviceName} (最后活跃: ${connection.lastActiveAt})`);
        });
      }
    } catch (error) {
      console.error('清理不活跃连接失败:', error);
    }
  }
}
module.exports = DeviceController;

setInterval(() => {// 启动定时清理不活跃连接的任务（每分钟执行一次）
  DeviceController.cleanupInactiveConnections();
}, 60 * 1000); // 1分钟 = 60 * 1000毫秒