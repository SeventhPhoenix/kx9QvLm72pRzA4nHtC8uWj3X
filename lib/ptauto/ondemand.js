(function() {
	const fs = require('fs');
	const axios = require('axios');
	const converter = require('xml-js');
	const utils = require('#lib/utils.js');
	const VOD_HOST = [115, 101, 114, 118, 105, 99, 101, 45, 118, 111, 100, 46, 99, 108, 117, 115, 116, 101, 114, 115, 46, 112, 108, 117, 116, 111, 46, 116, 118].map((c) => String.fromCharCode(c)).join('');
	const HTTP_TIMEOUT_MS = 20000;
	const client = axios.create({ timeout: HTTP_TIMEOUT_MS });
	const TOP_VOD_COUNT = 100;
	const PAGE_SIZE = 1000;
	const ONDEMAND_GROUP_TITLE = 'On Demand';

	let categoriesList = null;
	const onDemandCategories = async (config, region, bootData) => {
		const jwt = bootData.sessionToken;
		const headers = {
			Authorization: `Bearer ${jwt}`
		};

		if (region) headers['X-Forwarded-For'] = config.get('mapping')[region];

		const resp = await client.get(`https://${VOD_HOST}/v4/vod/categories?includeItems=false&includeCategoryFields=iconSvg&offset=1000&page=1&sort=number%3Aasc`, {headers});

		categoriesList = resp.data;
		return categoriesList;
	}

	const getItems = async (config, region, categoryID, bootData, page = 1) => {
		const jwt = bootData.sessionToken;
		const headers = {
			Authorization: `Bearer ${jwt}`
		};

		if (region) headers['X-Forwarded-For'] = config.get('mapping')[region];

		const resp = await client.get(`https://${VOD_HOST}/v4/vod/categories/${categoryID}/items?offset=${PAGE_SIZE}&page=${page}`, {headers});
		return resp.data;
	}

	const getVodItem = async (config, region, id, bootData) => {
		const jwt = bootData.sessionToken;
		const headers = {
			Authorization: `Bearer ${jwt}`
		};

		if (region) headers['X-Forwarded-For'] = config.get('mapping')[region];

		const resp = await client.get(`https://${VOD_HOST}/v4/vod/items?ids=${id}`, {headers});
		return resp.data ? resp.data[0] : {};
	}

	const getCategoryItems = async (config, region, categoryID, bootData, limit = Infinity) => {
		const allItems = [];
		let page = 1;
		let categoryName = '';

		while (allItems.length < limit) {
			const data = await getItems(config, region, categoryID, bootData, page);
			if (!categoryName) categoryName = data?.name || '';
			const pageItems = Array.isArray(data?.items) ? data.items : [];
			if (!pageItems.length) break;

			allItems.push(...pageItems);
			if (allItems.length >= limit) break;
			if (pageItems.length < PAGE_SIZE) break;
			if (data?.totalPages && page >= data.totalPages) break;
			page++;
		}

		return {
			name: categoryName,
			items: allItems.slice(0, limit)
		};
	};

	const getSelectedVods = async (config, region, bootData) => {
		const categories = categoriesList?.categories || [];
		const includeAllVods = !!config.get('ondemandAll');

		if (!includeAllVods) {
			const topTitlesCategory = categories.find((entry) => `${entry?.name || ''}`.trim().toLowerCase() === 'top titles');
			if (topTitlesCategory) {
				const topTitlesData = await getCategoryItems(config, region, topTitlesCategory._id, bootData, PAGE_SIZE);
				return topTitlesData.items
					.filter((item) => item?.type === 'movie')
					.slice(0, TOP_VOD_COUNT)
					.map((item) => ({
						id: item._id,
						name: item.name,
						groupTitle: ONDEMAND_GROUP_TITLE
					}));
			}

			// Some regions do not have a "Top Titles" category; fallback to first N movies across categories.
			console.log('Top Titles category not found, falling back to category scan for top VOD picks');
			const selected = [];
			const seen = new Set();
			for (const category of categories) {
				if (selected.length >= TOP_VOD_COUNT) break;
				const categoryData = await getCategoryItems(config, region, category._id, bootData, PAGE_SIZE);
				for (const item of categoryData.items) {
					if (selected.length >= TOP_VOD_COUNT) break;
					if (item?.type !== 'movie') continue;
					if (!item?._id || seen.has(item._id)) continue;
					seen.add(item._id);
					selected.push({
						id: item._id,
						name: item.name,
						groupTitle: ONDEMAND_GROUP_TITLE
					});
				}
			}
			return selected;
		}

		const selected = [];
		const seen = new Set();
		for (const category of categories) {
			const categoryData = await getCategoryItems(config, region, category._id, bootData, Infinity);
			for (const item of categoryData.items) {
				if (item?.type !== 'movie') continue;
				if (!item?._id || seen.has(item._id)) continue;
				seen.add(item._id);
				selected.push({
					id: item._id,
					name: item.name,
					groupTitle: ONDEMAND_GROUP_TITLE
				});
			}
		}
		return selected;
	};

	// TODO: consolidate this and the life playlist generation code
	const generateM3U8 = async (config, region, bootData) => {
		const xTvgUrl = config.get('xTvgUrl');
		let cache = {};
		let newCache = {};
		let numVods = 0;
		let vodChno = 9000;
		let m3u8 = "#EXTM3U\n\n";

		// try to init the cache
		const outdir = config.get('outdir') || '.';
		const cachefile = `${outdir}/ptauto_ondemand_${region}.cache`;
		try {
			cache = JSON.parse(fs.readFileSync(cachefile, 'utf-8'));
		} catch (ex) {
			cache = {};
		}

		if (xTvgUrl) {
			m3u8 = `#EXTM3U x-tvg-url="${xTvgUrl}"\n\n`;
		}

		const selectedVods = await getSelectedVods(config, region, bootData);
		if (!selectedVods.length) return { m3u8, numVods };

		let cacheDirty = false;
		for (let j = 0; j < selectedVods.length; j++) {
			const item = selectedVods[j];
			const id = item.id;
			const groupTitle = item.groupTitle || 'VOD';
			if (j < 5 || j % 25 === 0 || j === selectedVods.length - 1) {
				console.log(`VOD processing ${j + 1}/${selectedVods.length}: ${item.name}`);
			}
			cacheDirty |= !cache[`${id}-${region}`];
			const vodItem = cache[`${id}-${region}`] || await getVodItem(config, region, id, bootData);
			if (!vodItem) continue;

			newCache[`${id}-${region}`] = cache[`${id}-${region}`] = vodItem;

			const path = vodItem?.stitched?.path ||
				vodItem?.stitched?.paths?.find((entry) => entry?.type === 'hls')?.path ||
				false;
			if (!path) continue;

			const tvgChno = vodChno++;
			const url = `${bootData.servers.stitcher}/v2${path}?${bootData.stitcherParams}&jwt=${bootData.sessionToken}&masterJWTPassthrough=true`;
			const imagePath = vodItem?.featuredImage?.path || '';
			m3u8 += `#EXTINF:-1 tvg-id="${id}-${region}" tvg-logo="${imagePath}" tvg-chno="${tvgChno}" group-title="${groupTitle}", ${vodItem.name}\n${url}\n\n`;
			numVods++;

			newCache[`${id}-${region}`].stream_url = url;
		}
		if (cacheDirty) try {
			cacheDirty = false;
			fs.writeFileSync(cachefile, JSON.stringify(cache), 'utf-8');
		} catch (ex) {}

		try {
			newCache.categoriesList = categoriesList;
			fs.writeFileSync(cachefile, JSON.stringify(newCache), 'utf-8');
		} catch (ex) {
			console.log("got ex", ex.message);
		}

		console.log("done");
		return { m3u8, numVods }
	}

	const generateXMLTV = async (config, region) => {
		console.log("generating XMLTV for ondemand");
		let cache = false;
		// try to init the cache
		const outdir = config.get('outdir') || '.';
		const cachefile = `${outdir}/ptauto_ondemand_${region}.cache`;
		try {
			cache = JSON.parse(fs.readFileSync(cachefile, 'utf-8'));
		} catch (ex) {
			cache = false;
		}

		if (!cache) return "";

		const obj = {
			"_declaration": {
				"_attributes": {
					"version": "1.0",
					"encoding": "UTF-8"
				}
			},
			"_doctype": "tv SYSTEM \"xmltv.dtv\"",
			"tv": {
				"_attributes": {
					"source-info-name": "nobody,xmltv.net,nzxmltv.com"
				},
				"channel": [],
				"programme": []
			}
		};

		const channelIds = Object.keys(cache);
		for (let i = 0; i < channelIds.length; i++) {
			const id = channelIds[i];
			if (id === 'categoriesList') continue;

			const entry = cache[id];
			const channel = {
				"_attributes": {
					"id": id
				},
				"display-name": {
					"_text": entry.name
				},
				"icon": {
					"_attributes": {
						"src": utils.escapeHTML(entry?.featuredImage?.path || '')
					}
				}
			}
			obj.tv.channel.push(channel);

			const start = new Date(); start.setDate(start.getDate() - 1);
			const stop = new Date(); stop.setDate(stop.getDate() + 1);
			const programme = {
				"_attributes": {
					"channel": id,
					"start": `${utils.getTimeStr(start)} +0000`,
					"stop": `${utils.getTimeStr(stop)} +0000`
				},
				"title": {
					"_text": entry.name
				},
				"desc": {
					"_text": entry?.description || ''
				},
				"icon": {
					"_attributes": {
						"src": utils.escapeHTML(entry?.featuredImage?.path || '')
					}
				}
			}
			obj.tv.programme.push(programme);
		}

		console.log("converting");
		return converter.json2xml(JSON.stringify(obj), {compact: true, ignoreComment: true, spaces: 4});
	}

	exports = module.exports = {
		onDemandCategories,
		getItems,
		generateM3U8,
		generateXMLTV
	}
})();
