(function() {
	const fs = require('fs');
	const axios = require('axios');
	const utils = require('#lib/utils.js');
	const api = require('./api');
	const ondemand = require('./ondemand');

	const TVPASS_HEADER = '#EXTM3U x-tvg-url="https://tvpass.org/epg.xml"';
	const TVPASS_PLAYLIST_URL = 'https://tvpass.org/playlist/m3u';
	const THETVAPP_TOKEN_URL = 'https://thetvapp.to/token';
	const IPTV_ORG_CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
	const IPTV_ORG_LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
	const THETVAPP_COOKIE = 'XSRF-TOKEN=eyJpdiI6ImFJZUd0NXRVVFdvTm12dVM1Unh6SWc9PSIsInZhbHVlIjoiTnZTUDFCNEpENUtGUEN0TkNKUUxRTmNwREhpREVUdHdsWWNOaHEzaklxRWxhZE12WWFJa05HYjhrOGtGcDYvZHZtcDRNREdPNDhSNlo4RVFCQ1R5Qy82YjFGcUdTRm5rTU1iWm1Lb1c2R0FJWlpNeENNU0gvbFh2eXFUVWVxcjIiLCJtYWMiOiI1MmI2ODQyZjc1ZTk3YzRmZDQ0NTMxNzgwNTc1MzE2OGJiNzg5M2Y1ODdjNzZiNTFkZjMxODhkZDZiNTg1NzVkIiwidGFnIjoiIn0%3D; thetvapp_session=eyJpdiI6Imhhemt2TG9OM1VtWk9kNFFwLzU3SFE9PSIsInZhbHVlIjoiZUhHNTNrSk5oY1NRd3lUZUE1N3JsWnVRak5HU1VHajh4ODd0K1NGYzJpL1Z1RDVRdVZicm4zZFZGaUpUOVE3dkZqcHVlR0p0N05aMzJGQzdvanNXa1lZb1hxTGVYekJ4VytvN2VKY0ppKzV4eTcrR1hvek1RaE1JTnl6aXdSNFgiLCJtYWMiOiJlN2I2MDgxMjg4M2ZhNmYxYjBmMmI5YTM2Y2M2NTJiYzc3YWUwODczMTFhYWIwNjJmZjc4OWU2YzRjZTQ1YTZlIiwidGFnIjoiIn0%3D';
	const CHANNEL_NAME_SUFFIXES = [' US Eastern Feed', ' Eastern Feed', ' US East', ' (US)'];

	const cleanChannelName = (name) => {
		let cleaned = name;
		for (const suffix of CHANNEL_NAME_SUFFIXES) cleaned = cleaned.replace(suffix, '');
		return cleaned.trim().toLowerCase();
	};

	const createLogoMapFromOutputPlaylists = (outdir) => {
		const logoMap = new Map();
		const logoByIdMap = new Map();
		const files = fs.readdirSync(outdir).filter(file => /^ptauto_.*\.m3u8$/.test(file));

		for (const file of files) {
			const lines = fs.readFileSync(`${outdir}/${file}`, 'utf-8').split('\n');
			for (const line of lines) {
				if (!line.startsWith('#EXTINF:')) continue;
				const logoMatch = line.match(/tvg-logo="([^"]+)"/);
				if (!logoMatch) continue;
				const logo = logoMatch[1];
				const idMatch = line.match(/tvg-id="([^"]+)"/);
				if (idMatch && !logoByIdMap.has(idMatch[1])) logoByIdMap.set(idMatch[1], logo);
				const commaIdx = line.indexOf(',');
				if (commaIdx < 0) continue;
				const name = line.slice(commaIdx + 1).trim();
				if (!name) continue;
				const key = cleanChannelName(name);
				if (!logoMap.has(key)) logoMap.set(key, logo);
			}
		}

		return { logoMap, logoByIdMap };
	};

	const createLogoMapFromIptvOrg = async () => {
		const logoMap = new Map();
		const logoByIdMap = new Map();
		const [channelsRes, logosRes] = await Promise.all([
			axios.get(IPTV_ORG_CHANNELS_URL),
			axios.get(IPTV_ORG_LOGOS_URL)
		]);
		const channels = Array.isArray(channelsRes.data) ? channelsRes.data : [];
		const logos = Array.isArray(logosRes.data) ? logosRes.data : [];
		const namesByChannelId = new Map();

		for (const ch of channels) {
			if (!ch || !ch.id) continue;
			const names = [];
			if (ch.name) names.push(String(ch.name));
			if (Array.isArray(ch.alt_names)) {
				for (const altName of ch.alt_names) if (altName) names.push(String(altName));
			}
			namesByChannelId.set(ch.id, names);
		}

		for (const logoEntry of logos) {
			if (!logoEntry || !logoEntry.channel || !logoEntry.url) continue;
			const channelId = String(logoEntry.channel);
			const logo = String(logoEntry.url).trim();
			if (!logo) continue;

			if (!logoByIdMap.has(channelId)) logoByIdMap.set(channelId, logo);

			const names = namesByChannelId.get(channelId) || [];
			for (const name of names) {
				const key = cleanChannelName(name);
				if (key && !logoMap.has(key)) logoMap.set(key, logo);
			}
		}

		return { logoMap, logoByIdMap };
	};

	const withLogoIfMissing = (extinfLine, logoMap, logoByIdMap) => {
		if (!extinfLine.startsWith('#EXTINF:')) return extinfLine;
		const commaIdx = extinfLine.indexOf(',');
		if (commaIdx < 0) return extinfLine;
		const name = extinfLine.slice(commaIdx + 1).trim();
		const id = extinfLine.match(/tvg-id="([^"]+)"/)?.[1];
		const logo = (id ? logoByIdMap.get(id) : null) || logoMap.get(cleanChannelName(name));
		if (!logo) return extinfLine;
		if (extinfLine.includes('tvg-logo=""')) return extinfLine.replace('tvg-logo=""', `tvg-logo="${logo}"`);
		if (extinfLine.includes('tvg-logo="')) return extinfLine;
		return `${extinfLine.slice(0, commaIdx)} tvg-logo="${logo}"${extinfLine.slice(commaIdx)}`;
	};

	const stripSuffixes = (value) => {
		let out = value;
		for (const suffix of CHANNEL_NAME_SUFFIXES) out = out.replace(suffix, '');
		return out.trim();
	};

	const normalizePremiumExtinfLine = (line) => {
		if (!line.startsWith('#EXTINF:')) return line;

		let out = line.replace('group-title="Live"', 'group-title="Premium Channels"');
		out = out.replace(/tvg-name="([^"]*)"/, (_, tvgName) => `tvg-name="${stripSuffixes(tvgName)}"`);

		const commaIdx = out.indexOf(',');
		if (commaIdx < 0) return out;
		const title = out.slice(commaIdx + 1).trim();
		return `${out.slice(0, commaIdx)},${stripSuffixes(title)}`;
	};

	const generatePremiumPlaylist = async (outdir) => {
		let logoMap = new Map();
		let logoByIdMap = new Map();
		try {
			const iptvOrgMaps = await createLogoMapFromIptvOrg();
			logoMap = iptvOrgMaps.logoMap;
			logoByIdMap = iptvOrgMaps.logoByIdMap;
			console.log(`Loaded ${logoMap.size} IPTV-Org logo name matches`);
		} catch (ex) {
			console.warn('WARN: failed to load IPTV-Org logos, falling back to local playlists:', ex.message);
			const localMaps = createLogoMapFromOutputPlaylists(outdir);
			logoMap = localMaps.logoMap;
			logoByIdMap = localMaps.logoByIdMap;
		}

		const res = await axios.get(TVPASS_PLAYLIST_URL);
		const premiumChannels = res.data
			.split('\n')
			.filter(line => !line.startsWith(TVPASS_HEADER));

		for (let i = 0; i < premiumChannels.length; i++) {
			const line = premiumChannels[i];
			const url = line.includes('https://tvpass.org/') ? line : null;

			if (url) {
				const slug = url.split('/').at(-2)?.split('.')[0];
				if (!slug) continue;
				console.log(`Updating ${slug}`);
				const tokenRes = await axios.get(`${THETVAPP_TOKEN_URL}/${slug}`, {
					headers: { Cookie: THETVAPP_COOKIE }
				});
				const newUrl = tokenRes.data.url;
				premiumChannels[i] = line.replace(url, newUrl).trim();
			} else {
				const normalized = normalizePremiumExtinfLine(line).trim();
				premiumChannels[i] = withLogoIfMissing(normalized, logoMap, logoByIdMap);
			}
		}

		fs.writeFileSync(`${outdir}/premium.m3u8`, `${premiumChannels.join('\n')}\n`, 'utf-8');
	};

	const process = async (config) => {
		const regionalPlaylists = {};
		const regionalEpgs = {};

		const mapping = config.getMapping();
		const group = config.get('group');
		const regionalize = config.get('regionalize');
		const all = config.get('all');
		const outdir = config.get('outdir');
		const excludeGroups = config.get('excludeGroups');
		const excludeChannels = config.get('excludeChannels');
		const xTvgUrl = config.get('xTvgUrl');
		const vlcopts = config.get('vlcopts');
		const pipeopts = config.get('pipeopts');

		let chno = config.get('chno');
		if (chno !== false) chno = +chno;

		const getRegion = async (region) => {
			console.info("INFO: processing", region);
			try {
				const clientID = config.get('clientID');
				const xff = mapping[region];

				let fullTvgUrl = false;
				if (xTvgUrl) fullTvgUrl =xTvgUrl + (xTvgUrl.endsWith('/') ? `ptauto_${region}.xml` : '');

				console.log("getting boot data");
				const bootData = await api.boot(xff, clientID);
				console.log("getting channels");
				const channels = await api.channels(xff);
				console.log("getting categories");
				const categories = await api.categories(xff);
				console.log("getting timelines");
				const timelines = await api.timelines(xff);

				console.log("generating m3u8");
				const { m3u8, numChannels } = await api.generateM3U8(
					region,
					group,
					regionalize,
					excludeGroups,
					excludeChannels,
					chno,
					fullTvgUrl,
					vlcopts,
					xff,
					pipeopts
				);

				if (chno !== false) chno += numChannels;

				console.log("generating xmltv");
				const xmltv = await api.generateXMLTV(region, regionalize);
				fs.writeFileSync(`${outdir}/ptauto_${region}.m3u8`, m3u8, 'utf-8');
				fs.writeFileSync(`${outdir}/ptauto_${region}.xml`, xmltv, 'utf-8');

				regionalPlaylists[region] = m3u8;
				regionalEpgs[region] = xmltv;

				if (config.get('ondemand')) {
					await ondemand.onDemandCategories(config, region, bootData);

					console.log("generating ondemand m3u8");
					const res = await ondemand.generateM3U8(config, region, bootData);
					if (res?.m3u8) fs.writeFileSync(`${outdir}/ptauto_ondemand_${region}.m3u8`, res.m3u8, 'utf-8');
					const xmltv = await ondemand.generateXMLTV(config, region);
					if (xmltv) fs.writeFileSync(`${outdir}/ptauto_ondemand_${region}.xml`, xmltv, 'utf-8');
					console.log("completed");
				}
			} catch (ex) {
				console.error("ERROR: got exception", ex.message);
			}
		}

		for (const key of Object.keys(mapping)) await getRegion(key);

		if (all && Object.keys(mapping).length > 1) {
			let fullTvgUrl = false;
			if (xTvgUrl) fullTvgUrl = xTvgUrl + (xTvgUrl.endsWith('/') ? 'ptauto_all.xml' : '');
			const m3u8 = utils.mergeM3U8(regionalPlaylists, fullTvgUrl);
			const xmltv = utils.mergeXMLTV(regionalEpgs);
			fs.writeFileSync(`${outdir}/ptauto_all.m3u8`, m3u8, 'utf-8');
			fs.writeFileSync(`${outdir}/ptauto_all.xml`, xmltv, 'utf-8');
		}

		try {
			await generatePremiumPlaylist(outdir);
			console.log('premium.m3u8 generated');
		} catch (ex) {
			console.error('ERROR: failed to generate premium.m3u8', ex.message);
		}
	}

	exports = module.exports = {
		process
	}
})();
