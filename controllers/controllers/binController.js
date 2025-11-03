const { Models, dbState } = require('../models');
const { Bin } = Models;
const STATUS = require('../utils/statusCodes');
const offlineCache = require('../utils/offlineCache');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

class BinController {
  // 新增垃圾桶
  static async addBin(req, res) {
    try {
      const { name, description, latitude, longitude, address, image, type } = req.body;
      // 如果数据库离线，先进行校验然后将新增请求写入本地队列并更新缓存，供游客模式查看
      if (dbState && dbState.online === false) {
        if (!name || name.trim().length === 0) return res.json({ code: 1, msg: '垃圾桶名称不能为空' });
        if (name.length > 50) return res.json({ code: 1, msg: '垃圾桶名称不能超过50个字符' });
        if (description && description.length > 200) return res.json({ code: 1, msg: '描述信息不能超过200个字符' });
        if (!latitude || !longitude) return res.json({ code: 1, msg: '位置信息不能为空' });
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return res.json({ code: 1, msg: '经纬度格式不正确' });

        const payload = {
          name: name.trim(),
          describe: description || '',
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          imagePath: image || '',
          type: type || 'normal',
          review: false,
          createdAt: new Date().toISOString()
        };
        const queued = offlineCache.pushQueue({ type: 'addBin', payload });
        // 把这条记录也加入本地缓存，供游客模式立即可见
        try {
          const cached = offlineCache.getCachedBins() || [];
          cached.unshift({ id: queued.id, name: payload.name, description: payload.describe, latitude: payload.latitude, longitude: payload.longitude, image: payload.imagePath, type: payload.type, review: payload.review, createdAt: payload.createdAt });
          offlineCache.setCachedBins(cached);
        } catch (e) {
          // 忽略缓存失败
        }
        return res.json({ code: 0, msg: '已记录到离线队列，稍后会自动同步', data: queued });
      }
      
      // 数据验证
      if (!name || name.trim().length === 0) {
        return res.json({ code: 1, msg: '垃圾桶名称不能为空' });
      }
      
      if (name.length > 50) {
        return res.json({ code: 1, msg: '垃圾桶名称不能超过50个字符' });
      }
      
      if (description && description.length > 200) {
        return res.json({ code: 1, msg: '描述信息不能超过200个字符' });
      }
      
      if (!latitude || !longitude) {
        return res.json({ code: 1, msg: '位置信息不能为空' });
      }
      
      // 验证经纬度范围
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return res.json({ code: 1, msg: '经纬度格式不正确' });
      }

      // 创建垃圾桶记录（默认review=false，等待审核）
      const newBin = await Bin.scope('withUnreviewed').create({
        name: name.trim(),
        describe: description || '',
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        imagePath: image || '',
        type: type || 'normal',
        review: false  // 新增的垃圾桶默认未审核
      });

      res.json({
        code: 0,
        msg: '垃圾桶新增成功，等待管理员审核',
        data: {
          id: newBin.id,
          name: newBin.name,
          description: newBin.describe,
          latitude: newBin.latitude,
          longitude: newBin.longitude,
          image: newBin.imagePath,
          type: newBin.type,
          review: newBin.review,
          createdAt: newBin.createdAt
        }
      });
      console.log(`🗑️ 新增垃圾桶 "${newBin.name}"，等待审核`);
    } catch (error) {
      console.error('新增垃圾桶错误:', error);
      res.json({ code: 1, msg: '新增失败: ' + error.message });
    }
  }

  // 获取垃圾桶列表（只返回已审核的）
  static async getBinList(req, res) {
    // 设置超时保护，地图加载不应该等太久
    const timeoutId = setTimeout(() => {
      if (!res.headersSent) {
        res.json({ code: 1, msg: '获取垃圾桶数据超时，请重试' });
      }
    }, 8000); // 8秒超时

    try {
      if (dbState && dbState.online === false) {
        // 返回本地缓存的垃圾桶供前端在游客模式显示
        const cached = offlineCache.getCachedBins() || [];
        clearTimeout(timeoutId);
        return res.json({ code: 0, msg: 'ok (cached)', data: cached, pagination: { total: cached.length, page: 1, pageSize: cached.length, totalPages: 1 } });
      }
      const { latitude, longitude, radius = 5000, page = 1, pageSize = 20 } = req.query;
      
      let whereCondition = {};
      
      // 如果提供了位置信息，计算附近的垃圾桶
      if (latitude && longitude) {
        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);
        const radiusKm = parseFloat(radius) / 1000; // 转换为公里
        
        // 使用Haversine公式计算距离（简化版本，适用于小范围）
        // 这里使用简单的矩形范围过滤，更精确的可以使用PostGIS或其他地理计算
        const latRange = radiusKm / 111; // 纬度1度约111km
        const lngRange = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
        
        whereCondition = {
          // latitude: {
          //   [require('sequelize').Op.between]: [lat - latRange, lat + latRange]
          // },
          // longitude: {
          //   [require('sequelize').Op.between]: [lng - lngRange, lng + lngRange]
          // }
        };
      }

      // 分页参数
      const offset = (parseInt(page) - 1) * parseInt(pageSize);
      const limit = parseInt(pageSize);

      // 查询已审核的垃圾桶（使用默认作用域）
  const { count, rows } = await Bin.findAndCountAll({
        where: whereCondition,
        offset,
        limit,
        order: [['createdAt', 'DESC']],
        // 优化查询，只获取必要的字段
        attributes: ['id', 'name', 'describe', 'latitude', 'longitude', 'imagePath', 'type', 'createdAt']
      });

      clearTimeout(timeoutId);
      
      // 更新本地缓存，供离线游客使用
      try {
        const mapped = rows.map(bin => ({ id: bin.id, name: bin.name, description: bin.describe, latitude: bin.latitude, longitude: bin.longitude, image: bin.imagePath, type: bin.type, createdAt: bin.createdAt }));
        offlineCache.setCachedBins(mapped);
      } catch (e) {
        // 忽略缓存写入失败
      }

      if (!res.headersSent) {
        res.json({
          code: 0,
          msg: 'success',
          data: rows.map(bin => ({
            id: bin.id,
            name: bin.name,
            description: bin.describe,
            latitude: bin.latitude,
            longitude: bin.longitude,
            image: bin.imagePath,
            type: bin.type,
            createdAt: bin.createdAt
          })),
          pagination: {
            total: count,
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            totalPages: Math.ceil(count / parseInt(pageSize))
          }
        });
      }
      
      console.log(`🗑️ 获取垃圾桶列表，返回 ${rows.length} 条记录`);
    } catch (error) {
      clearTimeout(timeoutId);
      console.error('获取垃圾桶列表错误:', error);
      if (!res.headersSent) {
        res.json({ code: 1, msg: '获取失败: ' + error.message });
      }
    }
  }

  // 管理员获取所有垃圾桶（包括未审核的）
  static async getAllBins(req, res) {
    const timeoutId = setTimeout(() => {
      if (!res.headersSent) {
        res.json({ code: 1, msg: '获取数据超时，请重试' });
      }
    }, 10000); // 10秒超时

    try {
      if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const { page = 1, pageSize = 20, review } = req.query;
      
      let scope = 'withUnreviewed';
      if (review === 'pending') {
        scope = 'pendingReview';
      } else if (review === 'approved') {
        scope = null; // 使用默认作用域
      }

      const offset = (parseInt(page) - 1) * parseInt(pageSize);
      const limit = parseInt(pageSize);

      const query = scope ? Bin.scope(scope) : Bin;
      const { count, rows } = await query.findAndCountAll({
        offset,
        limit,
        order: [['createdAt', 'DESC']],
        // 优化查询，只获取必要的字段
        attributes: ['id', 'name', 'describe', 'latitude', 'longitude', 'imagePath', 'type', 'review', 'createdAt', 'updatedAt']
      });

      clearTimeout(timeoutId);

      if (!res.headersSent) {
        res.json({
          code: 0,
          msg: 'success',
          data: rows.map(bin => ({
            id: bin.id,
            name: bin.name,
            description: bin.describe,
            latitude: bin.latitude,
            longitude: bin.longitude,
            image: bin.imagePath,
            type: bin.type,
            review: bin.review,
            createdAt: bin.createdAt,
            updatedAt: bin.updatedAt
          })),
          pagination: {
            total: count,
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            totalPages: Math.ceil(count / parseInt(pageSize))
          }
        });
      }
    } catch (error) {
      clearTimeout(timeoutId);
      console.error('管理员获取垃圾桶列表错误:', error);
      if (!res.headersSent) {
        res.json({ code: 1, msg: '获取失败: ' + error.message });
      }
    }
  }

  // 管理员审核垃圾桶
  static async approveBin(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const { id } = req.params;
      const { approved } = req.body;

      const bin = await Bin.scope('withUnreviewed').findByPk(id);
      if (!bin) {
        return res.json({ code: 1, msg: '垃圾桶不存在' });
      }

      bin.review = approved === true;
      await bin.save();

      res.json({
        code: 0,
        msg: approved ? '审核通过' : '审核拒绝',
        data: {
          id: bin.id,
          name: bin.name,
          review: bin.review
        }
      });
    } catch (error) {
      console.error('审核垃圾桶错误:', error);
      res.json({ code: 1, msg: '审核失败: ' + error.message });
    }
  }

  // 前端上报设备错误（用户上报）
  static async reportError(req, res) {
    try {
      if (dbState && dbState.online === false) {
        // 将上报写入本地队列，稍后同步
        const { device_id, reason } = req.body;
        const userId = req.userId || null;
        if (!device_id || !reason) return res.json({ code: 1, msg: 'device_id 和 reason 为必填项' });
        const queued = offlineCache.pushQueue({ type: 'reportError', payload: { device_id, reason, userId } });
        return res.json({ code: 0, msg: '已记录到离线队列，稍后会自动同步', data: queued });
      }
      const { device_id, reason } = req.body;
      const userId = req.userId || null;

      if (!device_id) {
        return res.json({ code: 1, msg: 'device_id 不能为空' });
      }
      if (!reason || reason.trim().length === 0) {
        return res.json({ code: 1, msg: '请提供错误原因' });
      }

      // 支持通过 id 或 name 查找
      const bin = await Bin.scope('withUnreviewed').findOne({
        where: {
          [require('sequelize').Op.or]: [
            { id: device_id },
            { name: device_id }
          ]
        }
      });

      if (!bin) {
        return res.json({ code: 1, msg: '对应的垃圾桶不存在' });
      }

      const reports = Array.isArray(bin.errorReport) ? bin.errorReport.slice() : [];
      reports.push({ userId, reason: reason.trim(), createdAt: new Date().toISOString() });
      bin.errorReport = reports;
      await bin.save();

      res.json({ code: 0, msg: '上报成功，我们会有管理员处理', data: { id: bin.id, errorReport: bin.errorReport } });
    } catch (error) {
      console.error('上报错误失败:', error);
      res.json({ code: 1, msg: '上报失败: ' + error.message });
    }
  }

  // 上传垃圾桶图片
  static async uploadImage(req, res) {
    try {
      if (!req.file) {
        return res.json({ code: 1, msg: '请上传图片文件' });
      }

      // 确保images目录存在
      const imagesDir = path.join(__dirname, '../images');
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
      }

      // 生成唯一文件名
      const timestamp = Date.now();
      const ext = path.extname(req.file.originalname);
      const filename = `trash-bin-${timestamp}${ext}`;
      const filepath = path.join(imagesDir, filename);

      // 保存文件
      fs.writeFileSync(filepath, req.file.buffer);

      // 返回图片访问路径
      const imageUrl = `/images/${filename}`;

      res.json({
        code: 0,
        msg: '图片上传成功',
        data: {
          url: imageUrl,
          path: filepath
        }
      });
    //   console.log(`🗑️ 上传垃圾桶图片: ${filename}`);
    } catch (error) {
      console.error('上传图片错误:', error);
      res.json({ code: 1, msg: '上传失败: ' + error.message });
    }
  }

  // 删除垃圾桶（管理员功能）
  static async deleteBin(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const { id } = req.params;

      const bin = await Bin.scope('withUnreviewed').findByPk(id);
      if (!bin) {
        return res.json({ code: 1, msg: '垃圾桶不存在' });
      }

      // 删除关联的图片文件
      if (bin.imagePath && bin.imagePath.startsWith('/images/')) {
        const imagePath = path.join(__dirname, '..', bin.imagePath);
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
        }
      }

      await bin.destroy();

      res.json({
        code: 0,
        msg: '删除成功',
        data: { id: bin.id, name: bin.name }
      });
    } catch (error) {
      console.error('删除垃圾桶错误:', error);
      res.json({ code: 1, msg: '删除失败: ' + error.message });
    }
  }
}

module.exports = BinController;
