const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');

dotenv.config();

// 创建一个没有指定数据库的连接用于创建数据库
const initSequelize = new Sequelize({
  dialect: 'mysql',
  host: process.env.MYSQL_HOST || 'rubbish-db-mysql.ns-hh6q93qe.svc',
  port: process.env.MYSQL_PORT || 3306,
  username: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'svlpb86n',
});

// 创建数据库（如果不存在）
const dbName = process.env.MYSQL_DATABASE || 'rubbish_db';

// 使用 async 函数初始化数据库
async function initDatabase() {
  try {
    await initSequelize.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
    console.log(`✅ 数据库 ${dbName} 创建成功或已存在`);
    await initSequelize.close();
  } catch (err) {
    // 在无法创建数据库时不要退出进程，允许程序以离线/游客模式运行
    console.error('⚠️ 创建数据库失败（将以游客模式运行）:', err && err.message ? err.message : err);
    try {
      await initSequelize.close();
    } catch (e) { /* ignore cleanup errors */ }
    // return 而不是退出，后续模块会处理连接失败逻辑
    return;
  }
}

// 执行初始化
initDatabase();

// 创建实际使用的数据库连接
const sequelize = new Sequelize({
  dialect: 'mysql',
  host: process.env.MYSQL_HOST || 'rubbish-db-mysql.ns-hh6q93qe.svc',
  port: process.env.MYSQL_PORT || 3306,
  username: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'svlpb86n',
  database: process.env.MYSQL_DATABASE || 'rubbish_db',
  logging: false,
  define: {
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
    timestamps: true
  },
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
});

module.exports = sequelize;
