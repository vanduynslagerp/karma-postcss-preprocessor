const path = require('path');
const {merge} = require('lodash');
const {FSWatcher} = require('chokidar');
const nodeify = require('nodeify');
const sourceMappingURL = require('source-map-url');
const minimatch = require('minimatch');
const postcss = require('postcss');

/**
 * Postcss preprocessor factory.
 *
 * @param {Object} args Config object of custom preprocessor.
 * @param {Object} [config={}] Karma's config.
 * @param {Object} logger Karma's logger.
 * @param {Object} server Karma's server.
 * @return {Function} the function to preprocess files.
 */
function createPostcssPreprocessor(args, config, logger, server) {
	const preprocessorConfig = config.postcssPreprocessor || {};
	const log = logger.create('preprocessor.postcss');
	const options = merge({sourceMap: false}, args.options || {}, preprocessorConfig.options || {});
	const transformPath =
		args.transformPath ||
		preprocessorConfig.transformPath ||
		(filepath => `${path.dirname(filepath)}/${path.basename(filepath, path.extname(filepath))}.css`);
	let watcher;
	const dependencies = {};
	const unlinked = [];

	if (config.autoWatch) {
		watcher = new FSWatcher({persistent: true, disableGlobbing: true})
			.on('change', filePath => {
				log.info('Changed file "%s".', filePath);
				server.refreshFiles();
			})
			.on('add', filePath => {
				if (unlinked.includes(filePath)) {
					log.info('Added file "%s".', filePath);
					server.refreshFiles();
				}
			})
			.on('unlink', filePath => {
				log.info('Deleted file "%s".', filePath);
				unlinked.push(filePath);
				server.refreshFiles();
			});
	}

	return (content, file, done) => {
		log.debug('Processing "%s".', file.originalPath);
		file.path = transformPath(file.originalPath);

		// Clone the options because we need to mutate them
		const opts = {...options};

		// Inline source maps
		if (opts.sourceMap || opts.map) {
			opts.map = {inline: false};
		}

		opts.from = file.originalPath;
		opts.to = file.originalPath;

		nodeify(
			(async () => {
				try {
					const result = await postcss(opts.plugins || []).process(content, opts);
					if (
						config.autoWatch &&
						config.files.find(
							configFile => configFile.watched && minimatch(file.originalPath, configFile.pattern, {dot: true})
						)
					) {
						const fullPath = path.resolve(file.originalPath);
						const includedFiles = [];
						const startWatching = [];
						const stopWatching = [];

						for (let i = 0, {length} = result.messages; i < length; i++) {
							if (result.messages[i].type === 'dependency') {
								const includedFile = path.resolve(result.messages[i].file);

								includedFiles.push(includedFile);
								if (!dependencies[includedFile]) {
									startWatching.push(includedFile);
									log.debug('Watching "%s"', includedFile);
									dependencies[includedFile] = [fullPath];
								} else if (!dependencies[includedFile].includes(fullPath)) {
									dependencies[includedFile].push(fullPath);
								}
							}
						}

						for (let i = 0, keys = Object.keys(dependencies), {length} = keys; i < length; i++) {
							if (!includedFiles.includes(keys[i])) {
								const index = dependencies[keys[i]].indexOf(fullPath);

								if (index !== -1) {
									dependencies[keys[i]].splice(index, 1);
									if (!dependencies[keys[i]].length > 0) {
										stopWatching.push(keys[i]);
										log.debug('Stop watching "%s"', keys[i]);
										delete dependencies[keys[i]];
									}
								}
							}
						}

						if (startWatching.length > 0) {
							watcher.add(startWatching);
						}

						if (stopWatching.length > 0) {
							watcher.unwatch(stopWatching);
						}
					}

					if (opts.map && result.map) {
						file.sourceMap = JSON.parse(result.map.toString());
						return `${sourceMappingURL.removeFrom(
							result.css
						)}\n${'//#'} sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(
							JSON.stringify(file.sourceMap)
						).toString('base64')}\n`;
					}

					return result.css;
					// })
				} catch (error) {
					log.error('%s\n  at %s:%d', error.message, file.originalPath, error.line);
					throw error;
				}
			})(),
			done
		);
	};
}

// Inject dependencies
createPostcssPreprocessor.$inject = ['args', 'config', 'logger', 'emitter'];

// Export preprocessor
module.exports = {'preprocessor:postcss': ['factory', createPostcssPreprocessor]};
