const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'state.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    return { lastRun: null, processed: {} };
  }
}

function save(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

module.exports = { load, save, STATE_PATH };
