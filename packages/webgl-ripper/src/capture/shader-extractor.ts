/**
 * ShaderExtractor — Captures GLSL shader sources, uniform maps,
 * and attribute bindings for each program.
 */

import type { CapturedShader, CapturedProgram, UniformInfo } from '../types';

export class ShaderExtractor {
    private shaders = new Map<number, CapturedShader>();
    private programs = new Map<number, CapturedProgram>();
    private uniformValues = new Map<number, Map<string, unknown>>(); // progId → name → value

    /* ---- Shader source ---- */

    captureShaderSource(shaderId: number, type: number, source: string): void {
        this.shaders.set(shaderId, {
            id: shaderId,
            type,
            source,
        });
    }

    /* ---- Program linking ---- */

    captureLinkProgram(programId: number, vsId: number, fsId: number): void {
        const vs = this.shaders.get(vsId);
        const fs = this.shaders.get(fsId);
        if (!vs || !fs) return;

        this.programs.set(programId, {
            id: programId,
            vertexShader: { ...vs },
            fragmentShader: { ...fs },
            uniforms: new Map(),
            attributes: new Map(),
        });
    }

    /* ---- Uniform tracking ---- */

    private static readonly MAX_UNIFORMS_PER_PROGRAM = 256;

    captureUniform(programId: number, name: string, type: string, value: unknown): void {
        const prog = this.programs.get(programId);
        if (!prog) return;
        if (prog.uniforms.size >= ShaderExtractor.MAX_UNIFORMS_PER_PROGRAM) return;

        prog.uniforms.set(name, {
            name,
            type: this.uniformTypeToGL(type),
            location: prog.uniforms.size,
            value,
        });

        // Also track in separate map for snapshot
        if (!this.uniformValues.has(programId)) {
            this.uniformValues.set(programId, new Map());
        }
        this.uniformValues.get(programId)!.set(name, value);
    }

    /* ---- Getters ---- */

    getShader(id: number): CapturedShader | undefined {
        return this.shaders.get(id);
    }

    getProgram(id: number): CapturedProgram | undefined {
        return this.programs.get(id);
    }

    getAllShaders(): CapturedShader[] {
        return Array.from(this.shaders.values());
    }

    getAllPrograms(): CapturedProgram[] {
        return Array.from(this.programs.values());
    }

    getUniformSnapshot(programId: number): Record<string, unknown> {
        const uniforms = this.uniformValues.get(programId);
        if (!uniforms) return {};
        return Object.fromEntries(uniforms);
    }

    getShaderCount(): number {
        return this.shaders.size;
    }

    getProgramCount(): number {
        return this.programs.size;
    }

    clear(): void {
        this.shaders.clear();
        this.programs.clear();
        this.uniformValues.clear();
    }

    /* ---- Analysis helpers ---- */

    /** Maximum shader source length to analyze (protects against ReDoS on huge shaders) */
    private static readonly MAX_ANALYSIS_LENGTH = 100_000;

    /**
     * Extract sampler2D uniform names from a fragment shader source.
     * These are the uniforms binding textures to materials.
     */
    extractSamplerUniforms(fragmentSource: string): string[] {
        // Limit input length to prevent ReDoS
        const src = fragmentSource.length > ShaderExtractor.MAX_ANALYSIS_LENGTH
            ? fragmentSource.slice(0, ShaderExtractor.MAX_ANALYSIS_LENGTH)
            : fragmentSource;
        const regex = /uniform\s+sampler(?:2D|Cube|3D|2DArray)\s+(\w+)/g;
        const samplers: string[] = [];
        let match;
        while ((match = regex.exec(src)) !== null) {
            samplers.push(match[1]);
        }
        return samplers;
    }

    /**
     * Detect PBR material properties from shader source analysis.
     */
    analyzeMaterialFromShader(programId: number): {
        isPBR: boolean;
        hasNormalMap: boolean;
        hasMetallicRoughness: boolean;
        hasEmissive: boolean;
    } {
        const prog = this.programs.get(programId);
        if (!prog) return { isPBR: false, hasNormalMap: false, hasMetallicRoughness: false, hasEmissive: false };

        // Limit input length to prevent ReDoS
        const source = prog.fragmentShader.source.length > ShaderExtractor.MAX_ANALYSIS_LENGTH
            ? prog.fragmentShader.source.slice(0, ShaderExtractor.MAX_ANALYSIS_LENGTH)
            : prog.fragmentShader.source;
        const fs = source.toLowerCase();
        return {
            isPBR: fs.includes('metallic') || fs.includes('roughness') || fs.includes('brdf') || fs.includes('pbr'),
            hasNormalMap: fs.includes('normalmap') || fs.includes('normal_map') || fs.includes('tangentspace'),
            hasMetallicRoughness: fs.includes('metallicroughness') || (fs.includes('metallic') && fs.includes('roughness')),
            hasEmissive: fs.includes('emissive') || fs.includes('emission'),
        };
    }

    /* ---- Internal ---- */

    /**
     * Parse GLSL vertex shader to extract attribute location → semantic name mappings.
     * Recognizes patterns like:
     *   layout(location = 0) in vec3 a_position;
     *   attribute vec3 aPosition;
     */
    parseAttributeBindings(vertexSource: string): Map<number, string> {
        const bindings = new Map<number, string>();

        // Pattern 1: layout(location = N) in type name;
        const layoutRegex = /layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s+in\s+\w+\s+(\w+)/g;
        let match;
        while ((match = layoutRegex.exec(vertexSource)) !== null) {
            const location = parseInt(match[1]);
            const name = match[2];
            bindings.set(location, this.inferSemanticName(name));
        }

        // Pattern 2: attribute type name; (no layout qualifier — uses getAttribLocation)
        if (bindings.size === 0) {
            const attrRegex = /(?:attribute|in)\s+\w+\s+(\w+)\s*;/g;
            let loc = 0;
            while ((match = attrRegex.exec(vertexSource)) !== null) {
                bindings.set(loc++, this.inferSemanticName(match[1]));
            }
        }

        return bindings;
    }

    /**
     * Map common GLSL attribute variable names to glTF semantic names.
     */
    private inferSemanticName(glslName: string): string {
        const n = glslName.toLowerCase();

        if (/\bpos(ition)?\b|\bvertex\b/.test(n)) return 'POSITION';
        if (/\bnorm(al)?\b/.test(n)) return 'NORMAL';
        if (/\btang(ent)?\b/.test(n)) return 'TANGENT';
        if (/te?x.?coord|\buv\b/.test(n)) return 'TEXCOORD_0';
        if (/\bcolor\b|\bcol\b/.test(n)) return 'COLOR_0';
        if (/\bjoint\b|\bbone\b|\bskin\b/.test(n)) return 'JOINTS_0';
        if (/\bweight\b/.test(n)) return 'WEIGHTS_0';

        return glslName; // fallback: use the raw name
    }

    private uniformTypeToGL(name: string): number {
        if (name.includes('1f') || name === 'uniform1f') return 0x1406; // FLOAT
        if (name.includes('2f')) return 0x8B50; // FLOAT_VEC2
        if (name.includes('3f')) return 0x8B51; // FLOAT_VEC3
        if (name.includes('4f')) return 0x8B52; // FLOAT_VEC4
        if (name.includes('1i') || name === 'uniform1i') return 0x1404; // INT
        if (name.includes('Matrix4')) return 0x8B5C; // FLOAT_MAT4
        if (name.includes('Matrix3')) return 0x8B5B; // FLOAT_MAT3
        return 0;
    }
}
