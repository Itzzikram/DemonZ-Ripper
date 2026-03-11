/**
 * OBJExporter — Converts a RipScene to Wavefront OBJ + MTL format.
 * Simpler format for quick mesh inspection and compatibility.
 */

import type { RipScene, RipMesh, RipPrimitive, RipMaterial } from '@platform/webgl-ripper';

export interface OBJExportResult {
    obj: string;
    mtl: string;
    textureFiles: Map<string, ArrayBuffer>;
}

export class OBJExporter {
    export(scene: RipScene): OBJExportResult {
        const textureFiles = new Map<string, ArrayBuffer>();
        const mtlName = 'scene.mtl';

        let obj = '';
        obj += `# Exported by DemonZ Ripper OBJExporter\n`;
        obj += `# Source: ${scene.metadata.sourceUrl}\n`;
        obj += `# Date: ${scene.metadata.capturedAt}\n`;
        obj += `mtllib ${mtlName}\n\n`;

        let globalVertexOffset = 1;
        let globalNormalOffset = 1;
        let globalUVOffset = 1;

        for (let mi = 0; mi < scene.meshes.length; mi++) {
            const mesh = scene.meshes[mi];
            obj += `o ${mesh.name}\n`;

            for (const prim of mesh.primitives) {
                // Material (fallback to DefaultMaterial if index is invalid)
                const matName = prim.materialIndex >= 0 && prim.materialIndex < scene.materials.length
                    ? scene.materials[prim.materialIndex].name
                    : 'DefaultMaterial';
                obj += `usemtl ${matName}\n`;

                // Vertices
                const posCount = prim.positions.length / 3;
                for (let i = 0; i < posCount; i++) {
                    const x = prim.positions[i * 3];
                    const y = prim.positions[i * 3 + 1];
                    const z = prim.positions[i * 3 + 2];
                    obj += `v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\n`;
                }

                // Normals
                if (prim.normals) {
                    const nCount = prim.normals.length / 3;
                    for (let i = 0; i < nCount; i++) {
                        const x = prim.normals[i * 3];
                        const y = prim.normals[i * 3 + 1];
                        const z = prim.normals[i * 3 + 2];
                        obj += `vn ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\n`;
                    }
                }

                // UVs
                if (prim.uvs) {
                    const uvCount = prim.uvs.length / 2;
                    for (let i = 0; i < uvCount; i++) {
                        const u = prim.uvs[i * 2];
                        const v = prim.uvs[i * 2 + 1];
                        obj += `vt ${u.toFixed(6)} ${v.toFixed(6)}\n`;
                    }
                }

                // Faces
                if (prim.indices) {
                    const triCount = prim.indices.length / 3;
                    for (let i = 0; i < triCount; i++) {
                        const i0 = prim.indices[i * 3] + globalVertexOffset;
                        const i1 = prim.indices[i * 3 + 1] + globalVertexOffset;
                        const i2 = prim.indices[i * 3 + 2] + globalVertexOffset;

                        if (prim.normals && prim.uvs) {
                            const n0 = prim.indices[i * 3] + globalNormalOffset;
                            const n1 = prim.indices[i * 3 + 1] + globalNormalOffset;
                            const n2 = prim.indices[i * 3 + 2] + globalNormalOffset;
                            const t0 = prim.indices[i * 3] + globalUVOffset;
                            const t1 = prim.indices[i * 3 + 1] + globalUVOffset;
                            const t2 = prim.indices[i * 3 + 2] + globalUVOffset;
                            obj += `f ${i0}/${t0}/${n0} ${i1}/${t1}/${n1} ${i2}/${t2}/${n2}\n`;
                        } else if (prim.normals) {
                            const n0 = prim.indices[i * 3] + globalNormalOffset;
                            const n1 = prim.indices[i * 3 + 1] + globalNormalOffset;
                            const n2 = prim.indices[i * 3 + 2] + globalNormalOffset;
                            obj += `f ${i0}//${n0} ${i1}//${n1} ${i2}//${n2}\n`;
                        } else {
                            obj += `f ${i0} ${i1} ${i2}\n`;
                        }
                    }
                } else {
                    // Non-indexed: every 3 vertices form a triangle
                    const triCount = posCount / 3;
                    for (let i = 0; i < triCount; i++) {
                        const i0 = globalVertexOffset + i * 3;
                        const i1 = globalVertexOffset + i * 3 + 1;
                        const i2 = globalVertexOffset + i * 3 + 2;

                        if (prim.normals && prim.uvs) {
                            const n0 = globalNormalOffset + i * 3;
                            const n1 = globalNormalOffset + i * 3 + 1;
                            const n2 = globalNormalOffset + i * 3 + 2;
                            const t0 = globalUVOffset + i * 3;
                            const t1 = globalUVOffset + i * 3 + 1;
                            const t2 = globalUVOffset + i * 3 + 2;
                            obj += `f ${i0}/${t0}/${n0} ${i1}/${t1}/${n1} ${i2}/${t2}/${n2}\n`;
                        } else if (prim.normals) {
                            const n0 = globalNormalOffset + i * 3;
                            const n1 = globalNormalOffset + i * 3 + 1;
                            const n2 = globalNormalOffset + i * 3 + 2;
                            obj += `f ${i0}//${n0} ${i1}//${n1} ${i2}//${n2}\n`;
                        } else {
                            obj += `f ${i0} ${i1} ${i2}\n`;
                        }
                    }
                }

                globalVertexOffset += posCount;
                if (prim.normals) globalNormalOffset += prim.normals.length / 3;
                if (prim.uvs) globalUVOffset += prim.uvs.length / 2;
            }

            obj += '\n';
        }

        // Build MTL
        let mtl = '';
        mtl += `# Exported by DemonZ Ripper OBJExporter\n\n`;

        for (const mat of scene.materials) {
            mtl += `newmtl ${mat.name}\n`;
            mtl += `Kd ${mat.baseColor[0].toFixed(4)} ${mat.baseColor[1].toFixed(4)} ${mat.baseColor[2].toFixed(4)}\n`;
            mtl += `d ${mat.baseColor[3].toFixed(4)}\n`;
            mtl += `illum 2\n`;

            // PBR → Phong approximation
            const specular = 1.0 - mat.roughness;
            mtl += `Ks ${specular.toFixed(4)} ${specular.toFixed(4)} ${specular.toFixed(4)}\n`;
            mtl += `Ns ${(specular * 100).toFixed(1)}\n`;

            if (mat.emissive[0] > 0 || mat.emissive[1] > 0 || mat.emissive[2] > 0) {
                mtl += `Ke ${mat.emissive[0].toFixed(4)} ${mat.emissive[1].toFixed(4)} ${mat.emissive[2].toFixed(4)}\n`;
            }

            // Texture references (bounds-checked)
            if (mat.albedoTextureIndex !== null && mat.albedoTextureIndex >= 0 && mat.albedoTextureIndex < scene.textures.length) {
                const tex = scene.textures[mat.albedoTextureIndex];
                if (tex?.data) {
                    const filename = `${tex.name}.png`;
                    mtl += `map_Kd ${filename}\n`;
                    textureFiles.set(filename, tex.data);
                }
            }
            if (mat.normalTextureIndex !== null && mat.normalTextureIndex >= 0 && mat.normalTextureIndex < scene.textures.length) {
                const tex = scene.textures[mat.normalTextureIndex];
                if (tex?.data) {
                    const filename = `${tex.name}_normal.png`;
                    mtl += `map_Bump ${filename}\n`;
                    textureFiles.set(filename, tex.data);
                }
            }

            mtl += '\n';
        }

        return { obj, mtl, textureFiles };
    }
}
