/** Returns the env value, or null when unset or still a placeholder like "your_api_key_here". */
function configured(name) {
  const v = (process.env[name] || '').trim();
  if (!v || /^your[_-]/i.test(v) || /_here$/i.test(v)) return null;
  return v;
}

module.exports = { configured };
