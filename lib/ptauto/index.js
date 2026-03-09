(function() {
	const fs = require('fs');
	const axios = require('axios');
	const utils = require('#lib/utils.js');
	const api = require('./api');
	const ondemand = require('./ondemand');

	const TVPASS_HEADER = '#EXTM3U x-tvg-url="https://tvpass.org/epg.xml"';
	const TVPASS_PLAYLIST_URL = 'https://tvpass.org/playlist/m3u';
	const TVPASS_CHANNEL_DATA_URL = 'https://raw.githubusercontent.com/TokyoghoulEs/iptv-scraper_Fork/refs/heads/main/tvpass/tvpass-channels-data.json';
	const THETVAPP_TOKEN_URL = 'https://thetvapp.to/token';
	const THETVAPP_COOKIE = 'XSRF-TOKEN=eyJpdiI6ImFJZUd0NXRVVFdvTm12dVM1Unh6SWc9PSIsInZhbHVlIjoiTnZTUDFCNEpENUtGUEN0TkNKUUxRTmNwREhpREVUdHdsWWNOaHEzaklxRWxhZE12WWFJa05HYjhrOGtGcDYvZHZtcDRNREdPNDhSNlo4RVFCQ1R5Qy82YjFGcUdTRm5rTU1iWm1Lb1c2R0FJWlpNeENNU0gvbFh2eXFUVWVxcjIiLCJtYWMiOiI1MmI2ODQyZjc1ZTk3YzRmZDQ0NTMxNzgwNTc1MzE2OGJiNzg5M2Y1ODdjNzZiNTFkZjMxODhkZDZiNTg1NzVkIiwidGFnIjoiIn0%3D; thetvapp_session=eyJpdiI6Imhhemt2TG9OM1VtWk9kNFFwLzU3SFE9PSIsInZhbHVlIjoiZUhHNTNrSk5oY1NRd3lUZUE1N3JsWnVRak5HU1VHajh4ODd0K1NGYzJpL1Z1RDVRdVZicm4zZFZGaUpUOVE3dkZqcHVlR0p0N05aMzJGQzdvanNXa1lZb1hxTGVYekJ4VytvN2VKY0ppKzV4eTcrR1hvek1RaE1JTnl6aXdSNFgiLCJtYWMiOiJlN2I2MDgxMjg4M2ZhNmYxYjBmMmI5YTM2Y2M2NTJiYzc3YWUwODczMTFhYWIwNjJmZjc4OWU2YzRjZTQ1YTZlIiwidGFnIjoiIn0%3D';
	const CHANNEL_NAME_SUFFIXES = [' US Eastern Feed', ' Eastern Feed', ' US East', ' (US)', ' USA', ' USA Eastern', ',NY', ', NY', ' US', ' Eastern', ' East', ' East Coast'];
	const LOOKUP_NOISE_WORDS = new Set(['east', 'eastern', 'feed', 'us', 'usa', 'hd', 'channel']);

	const cleanChannelName = (name) => {
		let cleaned = name;
		for (const suffix of CHANNEL_NAME_SUFFIXES) cleaned = cleaned.replace(suffix, '');
		return cleaned.trim().toLowerCase();
	};

	const normalizeLookupValue = (value) => (
		String(value || '')
			.toLowerCase()
			.replace(/&/g, ' and ')
			.replace(/\+/g, ' plus ')
			.replace(/!/g, '')
			.replace(/[^a-z0-9]+/g, ' ')
			.trim()
	);

	const buildLookupKeys = (value) => {
		const normalized = normalizeLookupValue(value);
		if (!normalized) return [];

		const keys = new Set([normalized, normalized.replace(/\s+/g, '')]);
		const filteredTokens = normalized
			.split(/\s+/)
			.filter(Boolean)
			.filter(token => !LOOKUP_NOISE_WORDS.has(token));

		if (filteredTokens.length) {
			keys.add(filteredTokens.join(' '));
			keys.add(filteredTokens.join(''));
		}
		return [...keys];
	};

	const addKeysToMap = (map, value, logo) => {
		for (const key of buildLookupKeys(value)) {
			if (key && !map.has(key)) map.set(key, logo);
		}
	};

	const addChannelMetaByKey = (map, value, meta) => {
		for (const key of buildLookupKeys(value)) {
			if (key && !map.has(key)) map.set(key, meta);
		}
	};

	const findExtinfCommaIndex = (line) => {
		if (typeof line !== 'string' || !line.length) return -1;
		let inQuotes = false;
		for (let i = 0; i < line.length; i++) {
			if (line[i] === '"') inQuotes = !inQuotes;
			if (line[i] === ',' && !inQuotes) return i;
		}
		return -1;
	};

	const upsertExtinfAttribute = (line, attr, value) => {
		if (!line.startsWith('#EXTINF:')) return line;
		if (value === null || value === undefined || value === '') return line;
		const commaIdx = findExtinfCommaIndex(line);
		if (commaIdx < 0) return line;
		const beforeComma = line.slice(0, commaIdx);
		const afterComma = line.slice(commaIdx);
		const attrPattern = new RegExp(`${attr}="[^"]*"`);
		if (attrPattern.test(beforeComma)) {
			return `${beforeComma.replace(attrPattern, `${attr}="${value}"`)}${afterComma}`;
		}
		return `${beforeComma} ${attr}="${value}"${afterComma}`;
	};

	const createLogoMapFromOutputPlaylists = (outdir) => {
		const logoMap = new Map();
		const logoByIdMap = new Map();
		const logoByStreamMap = new Map();
		const channelMetaByStreamMap = new Map();
		let files = [];
		try {
			files = fs.readdirSync(outdir).filter(file => /^ptauto_.*\.m3u8$/.test(file));
		} catch (ex) {
			return { logoMap, logoByIdMap, logoByStreamMap, channelMetaByStreamMap };
		}

		for (const file of files) {
			const lines = fs.readFileSync(`${outdir}/${file}`, 'utf-8').split('\n');
			for (const line of lines) {
				if (!line.startsWith('#EXTINF:')) continue;
				const logoMatch = line.match(/tvg-logo="([^"]+)"/);
				if (!logoMatch) continue;
				const logo = logoMatch[1];
				const idMatch = line.match(/tvg-id="([^"]+)"/);
				if (idMatch) addKeysToMap(logoByIdMap, idMatch[1], logo);
					const commaIdx = findExtinfCommaIndex(line);
					if (commaIdx < 0) continue;
					const name = line.slice(commaIdx + 1).trim();
				if (!name) continue;
				addKeysToMap(logoMap, cleanChannelName(name), logo);
				const group = line.match(/group-title="([^"]+)"/)?.[1];
				if (idMatch) {
					const meta = { logo, groupTitle: group || null };
					addChannelMetaByKey(channelMetaByStreamMap, idMatch[1], meta);
				}
			}
		}

		return { logoMap, logoByIdMap, logoByStreamMap, channelMetaByStreamMap };
	};

	const createLogoMapFromTvpassChannelData = async () => {
		const logoMap = new Map();
		const logoByIdMap = new Map();
		const logoByStreamMap = new Map();
		const channelMetaByStreamMap = new Map();
		const res = await axios.get(TVPASS_CHANNEL_DATA_URL);
		const channels = Array.isArray(res.data) ? res.data : [];

		for (const channel of channels) {
			if (!channel) continue;
			const logo = String(channel['tvg-logo'] || '').trim();
			const groupTitle = String(channel['group-title'] || '').trim();
			const streamName = String(channel['stream-name'] || '').trim();

			if (logo) {
				addKeysToMap(logoByIdMap, channel['tvg-id'], logo);
				addKeysToMap(logoByStreamMap, streamName, logo);
				addKeysToMap(logoMap, channel['tvg-name'], logo);
				addKeysToMap(logoMap, channel['channel-name'], logo);
			}

			if (streamName && (logo || groupTitle)) {
				addChannelMetaByKey(channelMetaByStreamMap, streamName, {
					logo: logo || null,
					groupTitle: groupTitle || null
				});
			}
		}

		return { logoMap, logoByIdMap, logoByStreamMap, channelMetaByStreamMap };
	};

	const extractStreamNameFromTvpassUrl = (line) => {
		if (!line || !line.includes('tvpass.org/')) return null;
		const match = line.match(/tvpass\.org\/(?:live|vod)\/([^/?#]+)\//i);
		return match ? match[1] : null;
	};

	const getChannelMetaFromMaps = ({ id, streamName, channelMetaByStreamMap }) => {
		for (const key of buildLookupKeys(id)) {
			const meta = channelMetaByStreamMap.get(key);
			if (meta) return meta;
		}

		for (const key of buildLookupKeys(streamName)) {
			const meta = channelMetaByStreamMap.get(key);
			if (meta) return meta;
		}

		return null;
	};

	const getLogoFromMaps = ({ id, name, streamName, logoMap, logoByIdMap, logoByStreamMap }) => {
		for (const key of buildLookupKeys(id)) {
			const logo = logoByIdMap.get(key);
			if (logo) return logo;
		}

		for (const key of buildLookupKeys(streamName)) {
			const logo = logoByStreamMap.get(key);
			if (logo) return logo;
		}

		for (const key of buildLookupKeys(name)) {
			const logo = logoMap.get(key);
			if (logo) return logo;
		}

		const cleanedName = cleanChannelName(name || '');
		for (const key of buildLookupKeys(cleanedName)) {
			const logo = logoMap.get(key);
			if (logo) return logo;
		}
		return null;
	};

		const withLogoIfMissing = (
			extinfLine,
			logoMap,
			logoByIdMap,
		logoByStreamMap,
		streamName,
		channelMetaByStreamMap
		) => {
			if (!extinfLine.startsWith('#EXTINF:')) return extinfLine;
			const commaIdx = findExtinfCommaIndex(extinfLine);
			if (commaIdx < 0) return extinfLine;
			const name = extinfLine.slice(commaIdx + 1).trim();
			const id = extinfLine.match(/tvg-id="([^"]+)"/)?.[1];
		const meta = getChannelMetaFromMaps({ id, streamName, channelMetaByStreamMap });
		const logo = getLogoFromMaps({
			id,
			name,
			streamName,
			logoMap,
			logoByIdMap,
			logoByStreamMap
		});

			let out = extinfLine;
			const finalLogo = meta?.logo || logo;
			if (finalLogo) out = upsertExtinfAttribute(out, 'tvg-logo', finalLogo);
			const finalGroup = meta?.groupTitle || null;
			if (finalGroup) {
				out = upsertExtinfAttribute(out, 'group-title', finalGroup);
				out = upsertExtinfAttribute(out, 'tvg-group', finalGroup);
			}
			return out;
		};

	const stripSuffixes = (value) => {
		let out = String(value || '');
		let changed = true;

		while (changed) {
			changed = false;
			for (const suffix of CHANNEL_NAME_SUFFIXES) {
				const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const re = new RegExp(`${escaped}`, 'gi');
				const next = out.replace(re, '');
				if (next !== out) {
					out = next;
					changed = true;
				}
			}
		}

		return out.replace(/\s{2,}/g, ' ').trim();
	};

	const sanitizeExtinfLine = (line) => {
		if (!line.startsWith('#EXTINF:')) return line;

		// Remove the malformed tvg/group fragment anywhere it appears.
		let out = line.replace(/ tvg-group="News",NY" group-title="Live"/gi, '');
		out = out.replace(/\s*tvg-group="News",NY"\s*group-title="Live"/gi, '');

		const commaIdx = findExtinfCommaIndex(out);
		if (commaIdx < 0) return out;

		const beforeComma = out.slice(0, commaIdx);
		let afterComma = out.slice(commaIdx + 1);

		// Clean only the display title; mutating the attribute block can corrupt malformed lines further.
		afterComma = stripSuffixes(afterComma);

		return `${beforeComma},${afterComma}`;
	};

	const generatePremiumPlaylist = async (outdir) => {
		let logoMap = new Map();
		let logoByIdMap = new Map();
		let logoByStreamMap = new Map();
		let channelMetaByStreamMap = new Map();
		try {
			const tvpassDataMaps = await createLogoMapFromTvpassChannelData();
			logoMap = tvpassDataMaps.logoMap;
			logoByIdMap = tvpassDataMaps.logoByIdMap;
			logoByStreamMap = tvpassDataMaps.logoByStreamMap;
			channelMetaByStreamMap = tvpassDataMaps.channelMetaByStreamMap;
			console.log(`Loaded ${logoMap.size} channel/logo matches from tvpass-channels-data.json`);
		} catch (ex) {
			console.warn('WARN: failed to load tvpass-channels-data.json, falling back to local playlists:', ex.message);
			const localMaps = createLogoMapFromOutputPlaylists(outdir);
			logoMap = localMaps.logoMap;
			logoByIdMap = localMaps.logoByIdMap;
			logoByStreamMap = localMaps.logoByStreamMap;
			channelMetaByStreamMap = localMaps.channelMetaByStreamMap;
		}

		const res = await axios.get(TVPASS_PLAYLIST_URL);
		const premiumChannels = res.data
			.split('\n')
			.filter(line => !line.startsWith(TVPASS_HEADER));

		for (let i = 0; i < premiumChannels.length; i++) {
			const line = premiumChannels[i];
			const url = line.includes('https://tvpass.org/') ? line : null;

			if (url) {
				const slug = extractStreamNameFromTvpassUrl(url) || url.split('/').at(-2)?.split('.')[0];
				if (!slug) continue;
				console.log(`Updating ${slug}`);
				const tokenRes = await axios.get(`${THETVAPP_TOKEN_URL}/${slug}`, {
					headers: { Cookie: THETVAPP_COOKIE }
				});
				const newUrl = tokenRes.data.url;
				premiumChannels[i] = line.replace(url, newUrl).trim();
			} else {
				const normalized = sanitizeExtinfLine(line).trim();
				const streamName = extractStreamNameFromTvpassUrl(premiumChannels[i + 1]);
				premiumChannels[i] = withLogoIfMissing(
					normalized,
					logoMap,
					logoByIdMap,
					logoByStreamMap,
					streamName,
					channelMetaByStreamMap
				);
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
		fs.mkdirSync(outdir, { recursive: true });

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
					const ondemandM3u8Path = `${outdir}/ptauto_ondemand_${region}.m3u8`;
					const ondemandXmlPath = `${outdir}/ptauto_ondemand_${region}.xml`;
					await ondemand.onDemandCategories(config, region, bootData);

					console.log("generating ondemand m3u8");
					const res = await ondemand.generateM3U8(config, region, bootData);
					fs.writeFileSync(ondemandM3u8Path, res?.m3u8 || '#EXTM3U\n', 'utf-8');
					const xmltv = await ondemand.generateXMLTV(config, region);
					fs.writeFileSync(
						ondemandXmlPath,
						xmltv || '<?xml version="1.0" encoding="UTF-8"?><tv></tv>',
						'utf-8'
					);
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
