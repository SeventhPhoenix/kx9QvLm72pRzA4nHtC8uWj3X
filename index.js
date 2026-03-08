#!/usr/bin/env node

process.title = "PTAUTO";

const check = (minver) => {
	let semver = process.versions.node.split('.');
	if (semver[0] < minver) {
		console.error(`ERROR: nodejs is too old. Version ${minver} or greater is required.`);
		console.error(`ERROR: ${process.versions.node} installed`);
		process.exit(1);
	}
};

check(16);

(async function() {
	const fs = require('fs');
	const path = require('path');
	const os = require('os');
	const crypto = require('crypto');

	const config = require('./lib/config');
	const ptauto = require('./lib/ptauto');
	const server = require('./lib/server');

	const configPath = path.join(__dirname, 'config.json');

	// Load existing config.json
	const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

	// Generate ultra-unique clientID (256-bit SHA hash)
	function generateUltraUniqueID() {
		const entropy = Buffer.concat([
			crypto.randomBytes(64), // strong CSPRNG
			Buffer.from(process.hrtime.bigint().toString()), // nanosecond timer
			Buffer.from(Date.now().toString()), // timestamp
			Buffer.from(os.hostname()), // machine fingerprint
			Buffer.from(os.userInfo().username || '')
		]);

		return crypto
			.createHash('sha256')
			.update(entropy)
			.digest('hex'); // 64-character hex string
	}

	rawConfig.clientID = generateUltraUniqueID();

	// Save updated config.json
	fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2) + '\n', 'utf8');

	console.log(`Generated ultra-unique clientID: ${rawConfig.clientID}`);

	// Now load config after writing the new clientID
	config.loadConfig();

	const port = config.get('port');
	const refresh = config.get('refresh');

	if (refresh && refresh < 3600) {
		console.error("ERROR: please set refresh interval to be at least 3600 seconds");
		process.exit(1);
	}

	if (port && refresh) {
		setInterval(() => ptauto.process(config), refresh * 1000);
		server.serve(config);
	} else if (port) {
		server.serve(config);
	} else {
		await ptauto.process(config);
	}
})();
