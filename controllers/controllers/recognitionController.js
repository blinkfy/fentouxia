const History = require('../models/History');
const User = require('../models/User');
const { dbState } = require('../models');
const STATUS = require('../utils/statusCodes');
const { Op } = require('sequelize');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { error } = require('console');

// YOLO 调用串行/限流队列：默认并发=1，可通过 YOLO_CONCURRENCY 配置
const YOLO_CONCURRENCY = Math.max(parseInt(process.env.YOLO_CONCURRENCY || '1', 10), 1);
const _yoloQueue = [];
let _yoloActive = 0;
function _scheduleYolo() {
  while (_yoloActive < YOLO_CONCURRENCY && _yoloQueue.length > 0) {
    const { fn, resolve, reject } = _yoloQueue.shift();
    _yoloActive++;
    (async () => {
      try {
        const r = await fn();
        resolve(r);
      } catch (e) {
        reject(e);
      } finally {
        _yoloActive--;
        _scheduleYolo();
      }
    })();
  }
}
function runYoloJob(fn) {
  return new Promise((resolve, reject) => {
    _yoloQueue.push({ fn, resolve, reject });
    _scheduleYolo();
  });
}
class RecognitionController {
  // 生成自定义输出文件名的工具函数
  static generateOutputFilename(originalFile, userId = null, prefix = 'result') {
    const timestamp = Date.now();
    const userPart = userId ? `u${userId}` : 'anonymous';
    const hash = crypto.createHash('md5').update(originalFile.buffer || originalFile.originalname).digest('hex').substring(0, 8);
    const fileExtension = path.extname(originalFile.originalname) || '.jpg';
    
    return `${prefix}_${userPart}_${timestamp}_${hash}${fileExtension}`;
  }
  // 图片上传与识别
  static async recognize(req, res) {
    try {
      if (!req.file) {
        return res.json({ code: 1, msg: '请上传图片' });
      }

      // 1) 保存原图到 temp 目录
      const tempDir = path.join(__dirname, '../temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const originalName = req.file.originalname;
      const tempInputPath = path.join(tempDir, originalName);
      fs.writeFileSync(tempInputPath, req.file.buffer);

      // 2) 仅将源文件名传给 YOLO 服务，服务从 temp 读取并覆盖保存到 temp
      const outputFilename = originalName; // 覆盖保存
      
      // 直接调用本地 Python 推理脚本（本地运行，使用文件路径或参数通信）
      let yoloData = {};
      try {
        const local = await RecognitionController.callYoloAPI(req.file, outputFilename);
        if (local && local.success && local.data) {
          yoloData = local.data;
        } else if(local&&!local.success){
          res.json({ code: 1, msg: local.error });
          return;
        }else{
          console.warn('本地 YOLO 推理未返回结果，返回空识别结果');
          yoloData = { labels: [] };
        }
      } catch (err) {
        console.error('本地 YOLO 推理异常，返回空识别结果:', err && err.message);
        yoloData = { labels: [] };
      }

      // 3) 从 temp 读取识别后的图像并转换为 Base64
      const tempOutputPath = path.join(tempDir, outputFilename);
      if (fs.existsSync(tempOutputPath)) {
        const imageBuffer = fs.readFileSync(tempOutputPath);
        const ext = path.extname(outputFilename).toLowerCase();
        const mime = (ext === '.png') ? 'image/png' : 'image/jpeg';
        yoloData.result_img_base64 = `data:${mime};base64,${imageBuffer.toString('base64')}`;
        yoloData.output_filename = path.basename(tempOutputPath);
      } else {
        console.warn(`❌ 识别后文件未找到: ${tempOutputPath}`);
        res.json({code:1,msg:'识别后文件未找到'});
        return;
      }

      // 为每个label增加垃圾类型名
      const classNameMap = {
        0: '其他垃圾',
        1: '有害垃圾',
        2: '可回收垃圾',
        3: '厨余垃圾'
      };
      const classDescribe = {
        0: '请投放到灰色其他垃圾桶中。常见物品：餐具、纸巾、烟头等。',
        1: '请投放到红色有害垃圾桶中，避免直接接触。常见物品：电池、灯管、药品等。',
        2: '请投放到蓝色可回收垃圾桶中，助力回收利用绿色环保。常见物品：纸张、塑料瓶、金属等。',
        3: '请投放到绿色厨余垃圾桶中，注意沥干水分。常见物品：剩菜剩饭、果皮等。'
      };
      if (Array.isArray(yoloData.labels)) {
        yoloData.labels = yoloData.labels.map(label => ({
          ...label,
          name: classNameMap[label.class] || '未知类型',
          describe: classDescribe[label.class] || ''
        }));
      }
      let wholePoint = 0;
      let pointsAwarded = 0;
      let dailyOnlineCount = 0;
      let reachedDailyLimit = false;
      
      // 只有数据库在线且识别成功且有 userId 时才保存历史与更新积分
      if (dbState && dbState.online && req.userId && yoloData.labels && yoloData.labels.length > 0) {
        // 取置信度最高的标签
        const bestLabel = yoloData.labels.reduce((best, cur) => cur.confidence > best.confidence ? cur : best);
        try {
          await History.create({
            userId: req.userId,
            imageUrl: yoloData.result_img_base64 || null, // 存储Base64字符串
            category: bestLabel.name,
            confidence: bestLabel.confidence,
            source: 'online' // 在线识别
          });

          // 更新用户积分 - 在线识别统一为1分，每日最多5分
          const user = await User.findByPk(req.userId);
          if (user) {
            // 检查今日已获得的在线识别积分
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const todayOnlineCount = await History.count({
              where: {
                userId: req.userId,
                source: 'online',
                createdAt: {
                  [Op.between]: [today, tomorrow]
                }
              }
            });

            dailyOnlineCount = todayOnlineCount;
            const pointsToAdd = 1; // 在线识别统一为1分
            const dailyLimit = 5; // 每日在线识别积分上限

            if (todayOnlineCount <= dailyLimit) { // 注意这里改为 <= 因为我们刚刚添加了一条记录
              user.points += pointsToAdd;
              await user.save();
              wholePoint = user.points;
              pointsAwarded = pointsToAdd;
            } else {
              wholePoint = user.points;
              reachedDailyLimit = true;
            }
          }
        } catch (e) {
          console.error('保存历史或更新用户积分失败（已跳过）:', e && e.message);
        }
      }
      
      console.log(`✅ YOLO推理完成: ${outputFilename}, 检测到 ${yoloData.labels ? yoloData.labels.length : 0} 个对象, 用户积分:${wholePoint}`);
      
      // 构建响应数据
      const responseData = {
        ...yoloData
      };

      // 如果用户已登录，添加积分信息
      if (req.userId) {
        responseData.pointsInfo = {
          pointsAwarded: pointsAwarded,
          currentTotalPoints: wholePoint,
          dailyOnlineCount: dailyOnlineCount,
          dailyLimit: 5,
          reachedDailyLimit: reachedDailyLimit
        };
      }

      res.json({
        code: 0,
        msg: '识别成功',
        data: responseData
      });
    } catch (error) {
      console.error('识别错误:', error);
      res.json({ code: 1, msg: '识别失败: ' + error.message });
    } finally {
      // 删除临时文件（有条件地删除以防止二次错误）
      try {
        const tempDir = path.join(__dirname, '../temp');
        if (req && req.file && req.file.originalname) {
          const updatedImagePath = path.join(tempDir, req.file.originalname);
          if (fs.existsSync(updatedImagePath)) fs.unlinkSync(updatedImagePath);
        }
      } catch (e) {
        // 忽略删除错误
      }
    }
  }

  // 调用YOLO本地模型
  static async callYoloAPI(file, customOutputName = null) {
    return runYoloJob(async () => {
      try {
      // HTTP 接口：调用已运行的 Flask YOLO 服务
      const serviceUrl = process.env.YOLO_HTTP_URL || 'http://127.0.0.1:5000/recognize';
      const timeoutMs = parseInt(process.env.YOLO_HTTP_TIMEOUT || '90000', 10); // 默认 90s

      const outputFileName = customOutputName || file.originalname;
      
      // 1) 首选 multipart 上传文件（服务端优先使用 image 字段）
      const form = new FormData();
      form.append('image', file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype || 'application/octet-stream'
      });
      form.append('output_filename', outputFileName);

      try {
        const resp = await axios.post(serviceUrl, form, {
          headers: form.getHeaders(),
          maxBodyLength: Infinity,
          timeout: timeoutMs
        });
        const data = resp && resp.data ? resp.data : null;
        if (!data) return { success: false, error: '空响应' };
        if (!data.output_filename && data.output_file) data.output_filename = data.output_file;
        if (!data.output_filename) data.output_filename = outputFileName;
        return { success: true, data };
      } catch (err) {
        console.warn('multipart 调用失败，尝试 JSON 回退:', err && err.message);
      }

      // 2) 回退：以 JSON 传 filename（要求 Node 与 Python 共享 temp）
      // 兜底确保临时文件存在
      const tempDir = path.join(__dirname, '../temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const tempFilePath = path.join(tempDir, file.originalname);
      if (!fs.existsSync(tempFilePath)) {
        try { fs.writeFileSync(tempFilePath, file.buffer); } catch (_) { /* ignore */ }
      }
      const resp2 = await axios.post(serviceUrl, {
        filename: file.originalname,
        output_filename: outputFileName
      }, { timeout: timeoutMs });
      const data2 = resp2 && resp2.data ? resp2.data : null;
      if (!data2) return { success: false, error: '空响应' };
      if (!data2.output_filename && data2.output_file) data2.output_filename = data2.output_file;
      if (!data2.output_filename) data2.output_filename = outputFileName;
      return { success: true, data: data2 };
    } catch (error) {
      console.error('❌ YOLO服务调用错误:', error && (error.message || error));
      return { success: false, error: error.message || error};
    }
    });
  }

  // 获取历史识别记录
  static async getHistory(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 10;

      // 获取总数
      const { count: total, rows: data } = await History.findAndCountAll({
        where: { userId: req.userId },
        order: [['createdAt', 'DESC']],
        offset: (page - 1) * pageSize,
        limit: pageSize
      });

      res.json({ code: 0, msg: 'success', data, total });
    } catch (error) {
      console.error('获取历史记录错误:', error);
      res.json({ code: 1, msg: '获取历史记录失败' });
    }
  }

  // 删除历史记录
  static async deleteHistory(req, res) {
    try {
  if (dbState && dbState.online === false) return res.json({ code: STATUS.DB_OFFLINE, msg: STATUS.MESSAGES.DB_OFFLINE });
      const { id } = req.params;
      
      const history = await History.destroy({
        where: {
          id: id,
          userId: req.userId
        }
      });

      if (!history) {
        return res.json({ code: 1, msg: '记录不存在或无权限删除' });
      }

      res.json({ code: 0, msg: '删除成功' });
    } catch (error) {
      console.error('删除历史记录错误:', error);
      res.json({ code: 1, msg: '删除失败' });
    }
  }
}

module.exports = RecognitionController;