/* typehints:start */
import type { Application } from "../application";
/* typehints:end */
import { sha1, CRC_PREFIX, computeCrc } from "./sensitive_utils.encrypt";
import { createLogger } from "./logging";
import { FILE_NOT_FOUND } from "../platform/storage";
import { accessNestedPropertyReverse } from "./utils";
import { IS_DEBUG, globalConfig } from "./config";
import { ExplainedResult } from "./explained_result";
import { decompressX64, compressX64 } from "./lzstring";
import { asyncCompressor, compressionPrefix } from "./async_compression";
import { compressObject, decompressObject } from "../savegame/savegame_compressor";
const debounce: any = require("debounce-promise");
const logger: any = createLogger("read_write_proxy");
const salt: any = accessNestedPropertyReverse(globalConfig, ["file", "info"]);
// Helper which only writes / reads if verify() works. Also performs migration
export class ReadWriteProxy {
    public app: Application = app;
    public filename = filename;
    public currentData: object = null;
    public debouncedWrite = debounce(this.doWriteAsync.bind(this), 50);

    constructor(app, filename) {
        // TODO: EXTREMELY HACKY! To verify we need to do this a step later
        if (G_IS_DEV && IS_DEBUG) {
            setTimeout((): any => {
                assert(this.verify(this.getDefaultData()).result, "Verify() failed for default data: " + this.verify(this.getDefaultData()).reason);
            });
        }
    }
    // -- Methods to override
    /** {} */
    verify(data: any): ExplainedResult {
        abstract;
        return ExplainedResult.bad();
    }
    // Should return the default data
    getDefaultData(): any {
        abstract;
        return {};
    }
    // Should return the current version as an integer
    getCurrentVersion(): any {
        abstract;
        return 0;
    }
    // Should migrate the data (Modify in place)
    /** {} */
    migrate(data: any): ExplainedResult {
        abstract;
        return ExplainedResult.bad();
    }
    // -- / Methods
    // Resets whole data, returns promise
    resetEverythingAsync(): any {
        logger.warn("Reset data to default");
        this.currentData = this.getDefaultData();
        return this.writeAsync();
    }
        static serializeObject(obj: object): any {
        const jsonString: any = JSON.stringify(compressObject(obj));
        const checksum: any = computeCrc(jsonString + salt);
        return compressionPrefix + compressX64(checksum + jsonString);
    }
        static deserializeObject(text: object): any {
        const decompressed: any = decompressX64(text.substr(compressionPrefix.length));
        if (!decompressed) {
            // LZ string decompression failure
            throw new Error("bad-content / decompression-failed");
        }
        if (decompressed.length < 40) {
            // String too short
            throw new Error("bad-content / payload-too-small");
        }
        // Compare stored checksum with actual checksum
        const checksum: any = decompressed.substring(0, 40);
        const jsonString: any = decompressed.substr(40);
        const desiredChecksum: any = checksum.startsWith(CRC_PREFIX)
            ? computeCrc(jsonString + salt)
            : sha1(jsonString + salt);
        if (desiredChecksum !== checksum) {
            // Checksum mismatch
            throw new Error("bad-content / checksum-mismatch");
        }
        const parsed: any = JSON.parse(jsonString);
        const decoded: any = decompressObject(parsed);
        return decoded;
    }
    /**
     * Writes the data asychronously, fails if verify() fails.
     * Debounces the operation by up to 50ms
     * {}
     */
    writeAsync(): Promise<void> {
        const verifyResult: any = this.internalVerifyEntry(this.currentData);
        if (!verifyResult.result) {
            logger.error("Tried to write invalid data to", this.filename, "reason:", verifyResult.reason);
            return Promise.reject(verifyResult.reason);
        }
        return this.debouncedWrite();
    }
    /**
     * Actually writes the data asychronously
     * {}
     */
    doWriteAsync(): Promise<void> {
        return asyncCompressor
            .compressObjectAsync(this.currentData)
            .then((compressed: any): any => {
            return this.app.storage.writeFileAsync(this.filename, compressed);
        })
            .then((): any => {
            logger.log("📄 Wrote", this.filename);
        })
            .catch((err: any): any => {
            logger.error("Failed to write", this.filename, ":", err);
            throw err;
        });
    }
    // Reads the data asynchronously, fails if verify() fails
    readAsync(): any {
        // Start read request
        return (this.app.storage
            .readFileAsync(this.filename)
            // Check for errors during read
            .catch((err: any): any => {
            if (err === FILE_NOT_FOUND) {
                logger.log("File not found, using default data");
                // File not found or unreadable, assume default file
                return Promise.resolve(null);
            }
            return Promise.reject("file-error: " + err);
        })
            // Decrypt data (if its encrypted)
            // @ts-ignore
            .then((rawData: any): any => {
            if (rawData == null) {
                // So, the file has not been found, use default data
                return JSON.stringify(compressObject(this.getDefaultData()));
            }
            if (rawData.startsWith(compressionPrefix)) {
                const decompressed: any = decompressX64(rawData.substr(compressionPrefix.length));
                if (!decompressed) {
                    // LZ string decompression failure
                    return Promise.reject("bad-content / decompression-failed");
                }
                if (decompressed.length < 40) {
                    // String too short
                    return Promise.reject("bad-content / payload-too-small");
                }
                // Compare stored checksum with actual checksum
                const checksum: any = decompressed.substring(0, 40);
                const jsonString: any = decompressed.substr(40);
                const desiredChecksum: any = checksum.startsWith(CRC_PREFIX)
                    ? computeCrc(jsonString + salt)
                    : sha1(jsonString + salt);
                if (desiredChecksum !== checksum) {
                    // Checksum mismatch
                    return Promise.reject("bad-content / checksum-mismatch: " + desiredChecksum + " vs " + checksum);
                }
                return jsonString;
            }
            else {
                if (!G_IS_DEV) {
                    return Promise.reject("bad-content / missing-compression");
                }
            }
            return rawData;
        })
            // Parse JSON, this could throw but that's fine
            .then((res: any): any => {
            try {
                return JSON.parse(res);
            }
            catch (ex: any) {
                logger.error("Failed to parse file content of", this.filename, ":", ex, "(content was:", res, ")");
                throw new Error("invalid-serialized-data");
            }
        })
            // Decompress
            .then((compressed: any): any => decompressObject(compressed))
            // Verify basic structure
            .then((contents: any): any => {
            const result: any = this.internalVerifyBasicStructure(contents);
            if (!result.isGood()) {
                return Promise.reject("verify-failed: " + result.reason);
            }
            return contents;
        })
            // Check version and migrate if required
            .then((contents: any): any => {
            if (contents.version > this.getCurrentVersion()) {
                return Promise.reject("stored-data-is-newer");
            }
            if (contents.version < this.getCurrentVersion()) {
                logger.log("Trying to migrate data object from version", contents.version, "to", this.getCurrentVersion());
                const migrationResult: any = this.migrate(contents); // modify in place
                if (migrationResult.isBad()) {
                    return Promise.reject("migration-failed: " + migrationResult.reason);
                }
            }
            return contents;
        })
            // Verify
            .then((contents: any): any => {
            const verifyResult: any = this.internalVerifyEntry(contents);
            if (!verifyResult.result) {
                logger.error("Read invalid data from", this.filename, "reason:", verifyResult.reason, "contents:", contents);
                return Promise.reject("invalid-data: " + verifyResult.reason);
            }
            return contents;
        })
            // Store
            .then((contents: any): any => {
            this.currentData = contents;
            logger.log("📄 Read data with version", this.currentData.version, "from", this.filename);
            return contents;
        })
            // Catchall
            .catch((err: any): any => {
            return Promise.reject("Failed to read " + this.filename + ": " + err);
        }));
    }
    /**
     * Deletes the file
     * {}
     */
    deleteAsync(): Promise<void> {
        return this.app.storage.deleteFileAsync(this.filename);
    }
    // Internal
    /** {} */
    internalVerifyBasicStructure(data: any): ExplainedResult {
        if (!data) {
            return ExplainedResult.bad("Data is empty");
        }
        if (!Number.isInteger(data.version) || data.version < 0) {
            return ExplainedResult.bad(`Data has invalid version: ${data.version} (expected ${this.getCurrentVersion()})`);
        }
        return ExplainedResult.good();
    }
    /** {} */
    internalVerifyEntry(data: any): ExplainedResult {
        if (data.version !== this.getCurrentVersion()) {
            return ExplainedResult.bad("Version mismatch, got " + data.version + " and expected " + this.getCurrentVersion());
        }
        const verifyStructureError: any = this.internalVerifyBasicStructure(data);
        if (!verifyStructureError.isGood()) {
            return verifyStructureError;
        }
        return this.verify(data);
    }
}
