const fs = require("fs").promises;
const path = require("path");

const nunjucks = require("nunjucks");
const Case = require("case");

const logger = require("./logger");
const Parser = require("./parser");

class OrganizerLayer {
    constructor(organizeParent, configIndex) {
        this.configIndex = configIndex;

        this.memory = organizeParent.memory;
        this.configData = organizeParent.configArray[configIndex];

        this.directories = this.configData.directories;
        this.targetPath = this.configData.targetPath;
    }

    async onFileCreated(file, stats) {
        logger.info(`File Created: "${file}".`);

        await this.organizeDirectory();
    }

    async onFileDeleted(file) {
        logger.info(`File Deleted: "${file}".`);

        const linkExists = this.memory.findLinkWithSource(file);
        if (linkExists) {
            logger.info("Remove Link:", linkExists);

            try {
                await fs.unlink(linkExists.linkPath);
                this.memory.deleteLink(linkExists.linkPath);
            } catch (error) {
                logger.error("failed to unlink", linkExists.linkPath, error.toString());
            }
        }
    }

    async shouldCreateLink(filePath, linkPath, metaData) {
        let updateSymlink = false;

        const searchLink = this.memory.findLink(linkPath);
        if (searchLink) {
            if (searchLink.sourcePath !== filePath) {
                // different source files

                if (
                    this.configData.hasOwnProperty("useHighestQuality") &&
                    this.configData.useHighestQuality === true &&
                    metaData.hasOwnProperty("quality")
                ) {
                    const newQualityInteger =
                        typeof metaData.quality === "string"
                            ? metaData.quality.replace(/\D/g, "")
                            : metaData.quality;

                    if (searchLink.metaData.hasOwnProperty("quality")) {
                        const existingQualityInteger =
                            typeof searchLink.metaData.quality === "string"
                                ? searchLink.metaData.quality.replace(/\D/g, "")
                                : searchLink.metaData.quality;

                        if (
                            Number.isInteger(existingQualityInteger) &&
                            Number.isInteger(newQualityInteger) &&
                            existingQualityInteger < newQualityInteger
                        ) {
                            // more is better?
                            logger.info(
                                "Found better episode!",
                                metaData,
                                existingQualityInteger,
                                newQualityInteger
                            );
                            updateSymlink = true;
                        }
                    } else if (Number.isInteger(newQualityInteger)) {
                        // old had no quality
                        updateSymlink = true;
                    }
                }
            }
        } else {
            logger.debug("no old link!");
            updateSymlink = true;
        }
        return updateSymlink;
    }

    async organizeDirectory() {
        logger.info(`Running Config ${this.configIndex} (${this.directories.length} directories)`);

        if (this.configData.enabled === false) {
            logger.error(`Config ${this.configIndex} is disabled! (${this.directories.length} directories)`);
            return "disabled";
        }

        let directoryPromises = [];

        for (const index in this.directories) {
            const scanDir = path.resolve(this.directories[index]);

            directoryPromises.push(
                (async () => {
                    const fileTree = await this.getFiles(scanDir);
                    let parsedFileLinks = await this.parseFileTree(scanDir, fileTree);

                    parsedFileLinks = Array.from(new Set(parsedFileLinks));

                    await this.createLinks(scanDir, parsedFileLinks);
                })()
            );
        }

        const resolvedPromises = await Promise.all(directoryPromises);

        logger.info(`Config ${this.configIndex} completed! (${this.directories.length} directories)`);
        return resolvedPromises;
    }

    async getFiles(dir) {
        const subdirs = await fs.readdir(dir);

        const files = await Promise.all(
            subdirs.map(async (subdir) => {
                const res = path.resolve(dir, subdir);
                return (await fs.stat(res)).isDirectory() ? this.getFiles(res) : res;
            })
        );

        return files.reduce((a, f) => a.concat(f), []);
    }

    async parseFileTree(scanDir, files) {
        logger.info(`Organizing ${scanDir}...`);

        const results = await Promise.all(
            files.map(async (filePath) => {
                const parsedPath = path.parse(filePath);

                const fileIsMedia = await this.isAllowedFile(filePath);

                if (fileIsMedia) {
                    const movieOrSeries = await Parser.isMovieOrSeries(filePath);

                    if (this.configData.strictType) {
                        if (movieOrSeries !== this.configData.strictType) {
                            logger.verbose("wrong media type, ignoring", filePath, movieOrSeries);
                            return false;
                        }
                    }

                    const fileMediaInfo = await Parser.determineMediaInfo(filePath, movieOrSeries);

                    const targetLinkPath = this.formatSeriesPath(fileMediaInfo, parsedPath);

                    const updateSymlink = await this.shouldCreateLink(
                        filePath,
                        targetLinkPath,
                        fileMediaInfo
                    );

                    if (updateSymlink) {
                        this.memory.createLink(targetLinkPath, filePath, fileMediaInfo);

                        return targetLinkPath;
                    }
                }
                return false;
            })
        );

        logger.info(`.. Parsed tree for "${scanDir}"! (${results.length} files)`);
        return results;
    }

    async createLinks(scanDir, files) {
        logger.debug("files", files);
        const results = await Promise.all(
            files.map(async (createLink) => {
                if (createLink) {
                    const foundLink = this.memory.findLink(createLink);
                    logger.verbose("createLink", foundLink);

                    if (foundLink) {
                        await this.createSymlink(
                            foundLink.sourcePath,
                            foundLink.linkPath,
                            foundLink.metaData
                        );
                    } else {
                        logger.error("Unandled exception, link not found!");
                        throw new Error("Unandled exception, link not found!");
                    }
                }
            })
        );

        logger.info(`✔  Organized "${scanDir}"! (${results.length} link(s) created)`);
    }

    async isAllowedFile(filePath) {
        const fileInfo = path.parse(filePath);

        if (!fileInfo.ext) {
            return null;
        }
        const fileExt = fileInfo.ext.replace(".", "");

        const isInArray = (extensionsArray, fileExtension) => {
            let found = false;
            for (const item of extensionsArray) {
                if (item.toLowerCase().indexOf(fileExtension.toLowerCase()) !== -1) {
                    found = true;
                }
            }
            return found;
        };

        // TODO: Should probably be filtered in `getFiles` to avoid the additional fs.stat.
        if (Array.isArray(this.configData.allowedSize) && this.configData.allowedSize.length > 0) {
            const fileStat = await fs.stat(filePath);
            const fileSizeMB = Math.floor(fileStat.size / 1024000);

            const allowedSizeArray = this.configData.allowedSize;

            if (
                allowedSizeArray.length == 1 &&
                fileSizeMB < allowedSizeArray[0] // less than minimum size
            ) {
                return false;
            }

            if (
                allowedSizeArray.length == 2 &&
                fileSizeMB > allowedSizeArray[1] // more than maximum size
            ) {
                return false;
            }
        }

        let allowedFile = false;
        if (
            Array.isArray(this.configData.allowedExtensions) &&
            this.configData.allowedExtensions.length !== 0
        ) {
            if (isInArray(this.configData.allowedExtensions, fileExt)) {
                allowedFile = true;
            }
        } else {
            allowedFile = true;
        }

        if (
            Array.isArray(this.configData.ignoredExtensions) &&
            isInArray(this.configData.ignoredExtensions, fileExt)
        ) {
            allowedFile = false;
        }

        return allowedFile;
    }

    formatSeriesPath(targetMetadata, fileInfo) {
        const { targetFormat, targetPath } = this.configData;

        const njFormatter = new nunjucks.Environment();
        njFormatter.addFilter("caseFormat", (string, argument) => {
            return Case[argument](string);
        });

        njFormatter.addFilter("appendYear", (string) => {
            if (targetMetadata.hasOwnProperty("year") && targetMetadata.year) {
                return `${string} (${targetMetadata.year})`;
            }
            return string;
        });

        // normalize a string (remove unsafe filename chars)
        njFormatter.addFilter("normal", (string) => {
            return string.replace(/[#%&{}\/\\<>^*?$!'":`+|@=]/g, "");
        });

        const formatPathName = njFormatter.renderString(targetFormat, {
            ...targetMetadata,
            extension: fileInfo.ext.replace(".", "")
        });

        const savePath = path.normalize(formatPathName);

        const formattedPath = path.join(targetPath, savePath);

        return formattedPath;
    }

    async createSymlink(filePath, linkPath) {
        try {
            // create containing folder
            await fs.mkdir(path.dirname(linkPath), { recursive: true });

            try {
                await fs.unlink(linkPath);
            } catch (error) {
            } finally {
                try {
                    await fs.symlink(filePath, linkPath);
                } catch (error) {
                    logger.error("failed to link", filePath, linkPath, error.toString());
                }
            }
        } catch (error) {
            logger.error("failed to create symlink", error.toString());
        }
    }
}

module.exports = OrganizerLayer;
