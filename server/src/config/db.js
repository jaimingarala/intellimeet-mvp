const mongoose = require('mongoose');

const { log } = require('../lib/logger');

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set. Copy .env.example to .env and fill it in.');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  log.info('connected to MongoDB');
}

module.exports = connectDB;
