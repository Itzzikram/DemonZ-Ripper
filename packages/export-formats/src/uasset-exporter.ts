/**
 * UAssetExporter — Converts a RipScene to Unreal Engine .uasset + .uexp + .ubulk files.
 *
 * Generates UE4/5-compatible package files for static meshes and textures.
 * Uses the Unreal Engine package binary format with:
 *   - FPackageFileSummary header (magic 0x9E2A83C1)
 *   - Name Table, Import Table, Export Table
 *   - Export data in .uexp (mesh geometry, material refs)
 *   - Bulk data in .ubulk (texture pixel data)
 *
 * Coordinate system: WebGL (Y-up, meters) → UE (Z-up, centimeters)
 */

import type { RipScene, RipPrimitive, RipTexture, RipMaterial } from '@platform/webgl-ripper';

/* ================================================================== */
/*  Binary Writer Helper                                               */
/* ================================================================== */

class BinaryWriter {
    private buffer: ArrayBuffer;
    private view: DataView;
    private bytes: Uint8Array;
    private offset = 0;

    constructor(initialSize = 65536) {
        this.buffer = new ArrayBuffer(initialSize);
        this.view = new DataView(this.buffer);
        this.bytes = new Uint8Array(this.buffer);
    }

    private grow(needed: number): void {
        if (this.offset + needed <= this.buffer.byteLength) return;
        let newSize = this.buffer.byteLength * 2;
        while (newSize < this.offset + needed) newSize *= 2;
        const newBuf = new ArrayBuffer(newSize);
        new Uint8Array(newBuf).set(this.bytes);
        this.buffer = newBuf;
        this.view = new DataView(this.buffer);
        this.bytes = new Uint8Array(this.buffer);
    }

    getOffset(): number { return this.offset; }
    setOffset(off: number): void { this.offset = off; }

    writeInt32(val: number): void {
        this.grow(4);
        this.view.setInt32(this.offset, val, true);
        this.offset += 4;
    }

    writeUint32(val: number): void {
        this.grow(4);
        this.view.setUint32(this.offset, val, true);
        this.offset += 4;
    }

    writeInt64(val: number): void {
        this.grow(8);
        // Write as two 32-bit ints (little-endian)
        this.view.setInt32(this.offset, val & 0xFFFFFFFF, true);
        this.view.setInt32(this.offset + 4, Math.floor(val / 0x100000000), true);
        this.offset += 8;
    }

    writeUint16(val: number): void {
        this.grow(2);
        this.view.setUint16(this.offset, val, true);
        this.offset += 2;
    }

    writeFloat32(val: number): void {
        this.grow(4);
        this.view.setFloat32(this.offset, val, true);
        this.offset += 4;
    }

    writeBytes(data: Uint8Array | ArrayBuffer): void {
        const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        this.grow(arr.length);
        this.bytes.set(arr, this.offset);
        this.offset += arr.length;
    }

    /** Write a UE FString: int32 length + UTF-8 bytes + null terminator */
    writeFString(str: string): void {
        if (str.length === 0) {
            this.writeInt32(0);
            return;
        }
        const encoded = new TextEncoder().encode(str);
        this.writeInt32(encoded.length + 1); // +1 for null terminator
        this.writeBytes(encoded);
        this.grow(1);
        this.bytes[this.offset++] = 0; // null terminator
    }

    /** Write a UE FName entry (string + null + hash) */
    writeFNameEntry(str: string): void {
        const encoded = new TextEncoder().encode(str);
        this.writeInt32(encoded.length + 1);
        this.writeBytes(encoded);
        this.grow(1);
        this.bytes[this.offset++] = 0;
        this.writeUint32(0); // name hash (UE doesn't strictly require)
    }

    /** Patch a previously written int32 at a specific offset */
    patchInt32(offset: number, val: number): void {
        this.view.setInt32(offset, val, true);
    }

    toArrayBuffer(): ArrayBuffer {
        return this.buffer.slice(0, this.offset);
    }
}

/* ================================================================== */
/*  UAsset Format Constants                                            */
/* ================================================================== */

const PACKAGE_MAGIC = 0x9E2A83C1;
const PACKAGE_FILE_VERSION_UE4 = 522; // UE4.27
const PACKAGE_FILE_VERSION_UE5 = 1009; // UE5.3 (licensee ver 0)
const LICENSEE_VERSION = 0;

/* ================================================================== */
/*  Export Types                                                       */
/* ================================================================== */

export interface UAssetFile {
    filename: string;
    uasset: ArrayBuffer;
    uexp: ArrayBuffer;
    ubulk: ArrayBuffer | null;
}

export interface UAssetExportResult {
    files: UAssetFile[];
    totalSize: number;
}

/* ================================================================== */
/*  UAsset Exporter                                                    */
/* ================================================================== */

export class UAssetExporter {
    /**
     * Export a ripped scene as Unreal Engine .uasset packages.
     * Generates one package per mesh and one per texture.
     */
    export(scene: RipScene): UAssetExportResult {
        const files: UAssetFile[] = [];
        let totalSize = 0;

        // Export each mesh as a StaticMesh uasset
        for (let i = 0; i < scene.meshes.length; i++) {
            const mesh = scene.meshes[i];
            const name = `SM_${mesh.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            const material = mesh.primitives[0]?.materialIndex >= 0
                ? scene.materials[mesh.primitives[0].materialIndex]
                : null;

            const file = this.buildStaticMeshPackage(name, mesh.primitives, material);
            files.push(file);
            totalSize += file.uasset.byteLength + file.uexp.byteLength;
        }

        // Export each texture as a Texture2D uasset
        for (let i = 0; i < scene.textures.length; i++) {
            const tex = scene.textures[i];
            const name = `T_${tex.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;

            const file = this.buildTexturePackage(name, tex);
            files.push(file);
            totalSize += file.uasset.byteLength + file.uexp.byteLength;
            if (file.ubulk) totalSize += file.ubulk.byteLength;
        }

        return { files, totalSize };
    }

    /* ---- Static Mesh Package ---- */

    private buildStaticMeshPackage(
        packageName: string,
        primitives: RipPrimitive[],
        material: RipMaterial | null,
    ): UAssetFile {
        // Build the names table
        const names: string[] = [
            packageName,          // 0: package name
            'StaticMesh',         // 1: class name
            'None',               // 2: None sentinel
            '/Script/Engine',     // 3: engine module
            'Package',            // 4: Package class
            'StaticMeshComponent',// 5
            'BodySetup',          // 6
            material?.name ?? 'DefaultMaterial', // 7: material name
        ];

        // Build the import table (references to engine classes)
        const imports: { classPackage: number; className: number; outerIndex: number; objectName: number }[] = [
            { classPackage: 2, className: 4, outerIndex: 0, objectName: 3 }, // /Script/Engine package
            { classPackage: 3, className: 1, outerIndex: -1, objectName: 1 }, // StaticMesh class
        ];

        // Build the export table (the actual mesh object)
        const exports: {
            classIndex: number;
            superIndex: number;
            outerIndex: number;
            objectName: number;
            serialSize: number;
            serialOffset: number;
        }[] = [];

        // Serialize the mesh data into .uexp
        const uexpWriter = new BinaryWriter(1024 * 1024);
        const meshDataStart = uexpWriter.getOffset();

        // Write mesh geometry for each primitive
        // LOD count
        uexpWriter.writeInt32(primitives.length > 0 ? 1 : 0); // 1 LOD

        if (primitives.length > 0) {
            // LOD 0: sections count
            uexpWriter.writeInt32(primitives.length);

            for (let pi = 0; pi < primitives.length; pi++) {
                const prim = primitives[pi];
                this.writeStaticMeshSection(uexpWriter, prim, pi);
            }

            // Write vertex buffers consolidated
            this.writeVertexBuffers(uexpWriter, primitives);

            // Write index buffer
            this.writeIndexBuffer(uexpWriter, primitives);
        }

        const meshDataSize = uexpWriter.getOffset() - meshDataStart;

        // Add the mesh object to exports
        exports.push({
            classIndex: -2, // import index -2 = second import (StaticMesh class)
            superIndex: 0,
            outerIndex: 0,
            objectName: 0, // package name
            serialSize: meshDataSize,
            serialOffset: 0, // will be patched
        });

        // Now build the .uasset header
        const uassetWriter = new BinaryWriter(8192);
        this.writePackageHeader(uassetWriter, names, imports, exports);

        return {
            filename: packageName,
            uasset: uassetWriter.toArrayBuffer(),
            uexp: uexpWriter.toArrayBuffer(),
            ubulk: null,
        };
    }

    /** Write a single mesh section (material slot + triangle range) */
    private writeStaticMeshSection(w: BinaryWriter, prim: RipPrimitive, sectionIdx: number): void {
        w.writeInt32(sectionIdx);    // material index
        w.writeInt32(0);             // first index
        const numTriangles = prim.indices
            ? Math.floor(prim.indices.length / 3)
            : Math.floor(prim.vertexCount / 3);
        w.writeInt32(numTriangles);  // num triangles
        w.writeInt32(0);             // min vertex index
        w.writeInt32(prim.vertexCount - 1); // max vertex index
        w.writeUint32(1);            // bEnableCollision
        w.writeUint32(1);            // bCastShadow
    }

    /** Write consolidated vertex buffer data (positions, normals, UVs) */
    private writeVertexBuffers(w: BinaryWriter, primitives: RipPrimitive[]): void {
        // Calculate total vertex count
        let totalVerts = 0;
        for (const p of primitives) totalVerts += p.positions.length / 3;

        // Position buffer: float3 per vertex (converted Y-up → Z-up, meters → cm)
        w.writeInt32(totalVerts); // vertex count
        w.writeInt32(12);         // stride (3 * float32)
        for (const prim of primitives) {
            const count = prim.positions.length / 3;
            for (let i = 0; i < count; i++) {
                const x = prim.positions[i * 3] * 100;     // meters → cm
                const z = prim.positions[i * 3 + 1] * 100; // Y → Z (up)
                const y = prim.positions[i * 3 + 2] * 100; // Z → Y (forward)
                w.writeFloat32(x);
                w.writeFloat32(y);
                w.writeFloat32(z);
            }
        }

        // Normal buffer: packed normal + tangent (float3 each)
        w.writeInt32(totalVerts);
        w.writeInt32(24); // stride (2 * float3)
        for (const prim of primitives) {
            const count = prim.positions.length / 3;
            for (let i = 0; i < count; i++) {
                // Tangent (use X-axis if not available)
                if (prim.tangents) {
                    w.writeFloat32(prim.tangents[i * 4]);
                    w.writeFloat32(prim.tangents[i * 4 + 2]); // swap Y/Z
                    w.writeFloat32(prim.tangents[i * 4 + 1]);
                } else {
                    w.writeFloat32(1); w.writeFloat32(0); w.writeFloat32(0);
                }

                // Normal (swap Y/Z for coordinate system)
                if (prim.normals) {
                    w.writeFloat32(prim.normals[i * 3]);
                    w.writeFloat32(prim.normals[i * 3 + 2]); // swap Y/Z
                    w.writeFloat32(prim.normals[i * 3 + 1]);
                } else {
                    w.writeFloat32(0); w.writeFloat32(0); w.writeFloat32(1);
                }
            }
        }

        // UV buffer: float2 per vertex (channel 0)
        const hasUVs = primitives.some(p => p.uvs !== null);
        w.writeInt32(hasUVs ? 1 : 0); // UV channel count
        if (hasUVs) {
            w.writeInt32(totalVerts);
            w.writeInt32(8); // stride (2 * float32)
            for (const prim of primitives) {
                const count = prim.positions.length / 3;
                for (let i = 0; i < count; i++) {
                    if (prim.uvs) {
                        w.writeFloat32(prim.uvs[i * 2]);
                        w.writeFloat32(1.0 - prim.uvs[i * 2 + 1]); // flip V
                    } else {
                        w.writeFloat32(0);
                        w.writeFloat32(0);
                    }
                }
            }
        }

        // Vertex color buffer (optional)
        const hasColors = primitives.some(p => p.colors !== null);
        w.writeInt32(hasColors ? 1 : 0);
        if (hasColors) {
            w.writeInt32(totalVerts);
            w.writeInt32(4); // stride (RGBA8)
            for (const prim of primitives) {
                const count = prim.positions.length / 3;
                for (let i = 0; i < count; i++) {
                    if (prim.colors) {
                        const r = Math.round(Math.min(1, Math.max(0, prim.colors[i * 4])) * 255);
                        const g = Math.round(Math.min(1, Math.max(0, prim.colors[i * 4 + 1])) * 255);
                        const b = Math.round(Math.min(1, Math.max(0, prim.colors[i * 4 + 2])) * 255);
                        const a = Math.round(Math.min(1, Math.max(0, prim.colors[i * 4 + 3])) * 255);
                        w.writeBytes(new Uint8Array([r, g, b, a]));
                    } else {
                        w.writeBytes(new Uint8Array([255, 255, 255, 255]));
                    }
                }
            }
        }
    }

    /** Write consolidated index buffer */
    private writeIndexBuffer(w: BinaryWriter, primitives: RipPrimitive[]): void {
        // Calculate total indices
        let totalIndices = 0;
        let vertexOffset = 0;
        const allIndices: number[] = [];

        for (const prim of primitives) {
            const vertCount = prim.positions.length / 3;
            if (prim.indices) {
                for (let i = 0; i < prim.indices.length; i++) {
                    allIndices.push(prim.indices[i] + vertexOffset);
                }
                totalIndices += prim.indices.length;
            } else {
                for (let i = 0; i < vertCount; i++) {
                    allIndices.push(i + vertexOffset);
                }
                totalIndices += vertCount;
            }
            vertexOffset += vertCount;
        }

        const use32bit = vertexOffset > 65535;
        w.writeInt32(use32bit ? 4 : 2); // bytes per index
        w.writeInt32(totalIndices);

        if (use32bit) {
            for (const idx of allIndices) w.writeUint32(idx);
        } else {
            for (const idx of allIndices) w.writeUint16(idx);
        }

        // Pad to 4-byte alignment
        const remainder = (totalIndices * (use32bit ? 4 : 2)) % 4;
        if (remainder) {
            w.writeBytes(new Uint8Array(4 - remainder));
        }
    }

    /* ---- Texture Package ---- */

    private buildTexturePackage(packageName: string, tex: RipTexture): UAssetFile {
        const names: string[] = [
            packageName,       // 0
            'Texture2D',       // 1
            'None',            // 2
            '/Script/Engine',  // 3
            'Package',         // 4
        ];

        const imports: { classPackage: number; className: number; outerIndex: number; objectName: number }[] = [
            { classPackage: 2, className: 4, outerIndex: 0, objectName: 3 },
            { classPackage: 3, className: 1, outerIndex: -1, objectName: 1 },
        ];

        // Write texture metadata to .uexp
        const uexpWriter = new BinaryWriter(1024);
        const texStart = uexpWriter.getOffset();

        uexpWriter.writeInt32(tex.width);
        uexpWriter.writeInt32(tex.height);
        uexpWriter.writeInt32(1);  // depth
        uexpWriter.writeInt32(1);  // mip count
        uexpWriter.writeInt32(2);  // pixel format (PF_B8G8R8A8 = 2)
        uexpWriter.writeFString(packageName);

        const texSize = uexpWriter.getOffset() - texStart;

        const exports = [{
            classIndex: -2,
            superIndex: 0,
            outerIndex: 0,
            objectName: 0,
            serialSize: texSize,
            serialOffset: 0,
        }];

        // Texture pixel data goes into .ubulk
        let ubulk: ArrayBuffer | null = null;
        if (tex.data && tex.data.byteLength > 0) {
            ubulk = tex.data;
        }

        const uassetWriter = new BinaryWriter(4096);
        this.writePackageHeader(uassetWriter, names, imports, exports);

        return {
            filename: packageName,
            uasset: uassetWriter.toArrayBuffer(),
            uexp: uexpWriter.toArrayBuffer(),
            ubulk,
        };
    }

    /* ---- Package Header Writer ---- */

    private writePackageHeader(
        w: BinaryWriter,
        names: string[],
        imports: { classPackage: number; className: number; outerIndex: number; objectName: number }[],
        exports: { classIndex: number; superIndex: number; outerIndex: number; objectName: number; serialSize: number; serialOffset: number }[],
    ): void {
        // Magic
        w.writeUint32(PACKAGE_MAGIC);

        // Legacy version info
        w.writeInt32(-7);    // LegacyFileVersion (negative = UE4+)
        w.writeInt32(0);     // LegacyUE3Version
        w.writeInt32(PACKAGE_FILE_VERSION_UE4);  // FileVersionUE4
        w.writeInt32(LICENSEE_VERSION);
        w.writeInt32(0);     // CustomVersions count

        // Total header size (placeholder — will patch)
        const headerSizeOffset = w.getOffset();
        w.writeInt32(0);

        // Package group (FString "None")
        w.writeFString('None');

        // Package flags
        w.writeUint32(0x00000001); // PKG_NewlyCreated

        // Name count & offset (placeholder)
        const nameCountOffset = w.getOffset();
        w.writeInt32(names.length);
        const nameOffsetPlaceholder = w.getOffset();
        w.writeInt32(0);

        // Gatherable name (UE5)
        w.writeInt32(0); w.writeInt32(0);

        // Export count & offset (placeholder)
        const exportCountOffset = w.getOffset();
        w.writeInt32(exports.length);
        const exportOffsetPlaceholder = w.getOffset();
        w.writeInt32(0);

        // Import count & offset (placeholder)
        const importCountOffset = w.getOffset();
        w.writeInt32(imports.length);
        const importOffsetPlaceholder = w.getOffset();
        w.writeInt32(0);

        // Depends offset
        w.writeInt32(0);

        // String asset refs
        w.writeInt32(0); w.writeInt32(0);

        // Searchable names
        w.writeInt32(0); w.writeInt32(0);

        // Thumbnail table offset
        w.writeInt32(0);

        // Package GUID (unique per export)
        const guid = UAssetExporter.generateGuid();
        w.writeUint32(guid[0]);
        w.writeUint32(guid[1]);
        w.writeUint32(guid[2]);
        w.writeUint32(guid[3]);

        // Generations
        w.writeInt32(1); // generation count
        w.writeInt32(exports.length); // export count in generation
        w.writeInt32(names.length);   // name count in generation

        // Engine version
        w.writeUint32(5);    // major
        w.writeUint32(3);    // minor
        w.writeUint32(0);    // patch
        w.writeUint32(0);    // changelist
        w.writeFString('');  // branch name

        // Compatible engine version (same)
        w.writeUint32(5); w.writeUint32(3); w.writeUint32(0);
        w.writeUint32(0); w.writeFString('');

        // Compression flags
        w.writeUint32(0);

        // Compressed chunks (none)
        w.writeInt32(0);

        // Package source (UE4 package file hash)
        w.writeUint32(0);

        // Additional packages to cook (none)
        w.writeInt32(0);

        // Asset registry data offset
        w.writeInt32(-1);

        // Bulk data start offset (relative to file start, -1 = no bulk)
        w.writeInt64(-1);

        // World tile info offset
        w.writeInt32(0);

        // Chunk IDs (none)
        w.writeInt32(0);

        // ---- Write Name Table ----
        const nameTableOffset = w.getOffset();
        w.patchInt32(nameOffsetPlaceholder, nameTableOffset);

        for (const name of names) {
            w.writeFNameEntry(name);
        }

        // ---- Write Import Table ----
        const importTableOffset = w.getOffset();
        w.patchInt32(importOffsetPlaceholder, importTableOffset);

        for (const imp of imports) {
            w.writeInt32(imp.classPackage);  // class package FName index
            w.writeInt32(0);                  // FName number
            w.writeInt32(imp.className);     // class name FName index
            w.writeInt32(0);                  // FName number
            w.writeInt32(imp.outerIndex);    // outer index
            w.writeInt32(imp.objectName);    // object name FName index
            w.writeInt32(0);                  // FName number
        }

        // ---- Write Export Table ----
        const exportTableOffset = w.getOffset();
        w.patchInt32(exportOffsetPlaceholder, exportTableOffset);

        for (const exp of exports) {
            w.writeInt32(exp.classIndex);    // class index
            w.writeInt32(exp.superIndex);    // super index
            w.writeInt32(exp.outerIndex);    // outer index (0 = this package)
            w.writeInt32(exp.objectName);    // object name FName index
            w.writeInt32(0);                  // FName number
            w.writeUint32(0);                // object flags
            w.writeInt64(exp.serialSize);    // serial size
            w.writeInt64(0);                  // serial offset (data is in .uexp, offset 0)
            w.writeInt32(0);                  // bForcedExport
            w.writeInt32(0);                  // bNotForClient
            w.writeInt32(0);                  // bNotForServer
            w.writeUint32(0);                // package guid part 1
            w.writeUint32(0);                // package guid part 2
            w.writeUint32(0);                // package guid part 3
            w.writeUint32(0);                // package guid part 4
            w.writeUint32(0);                // package flags
        }

        // Patch total header size
        const totalHeaderSize = w.getOffset();
        w.patchInt32(headerSizeOffset, totalHeaderSize);
    }

    /** Generate a pseudo-random 128-bit GUID as four uint32 values */
    private static generateGuid(): [number, number, number, number] {
        const rand = () => (Math.random() * 0xFFFFFFFF) >>> 0;
        return [rand(), rand(), rand(), rand()];
    }
}
