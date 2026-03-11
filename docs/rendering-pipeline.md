# Rendering Pipeline — Technical Guide

## Overview

The rendering pipeline converts 3D model data into pixels on screen through a series of GPU-accelerated stages.

## Pipeline Stages

### 1. Scene Traversal

The scene graph is a tree of `SceneNode` objects. Each frame the engine traverses this tree depth-first to compute world transforms:

```
WorldTransform[child] = WorldTransform[parent] × LocalTransform[child]
```

Transform is stored as a 4×4 column-major matrix: `Float32Array(16)`.

### 2. Frustum Culling

Nodes outside the camera frustum are skipped. The perspective camera computes 6 frustum planes from the View-Projection matrix. Bounding spheres are tested against these planes.

### 3. Draw Call Sorting

Visible objects are sorted by:
1. **Material** — minimize shader switches
2. **Distance to camera** — front-to-back for opaque, back-to-front for transparent
3. **Buffer** — minimize VAO binds

### 4. GPU Upload

For each drawable:
- Bind VAO (vertex/index buffers)
- Bind shader program
- Upload uniforms (model/view/projection matrices, material properties)
- Bind textures (albedo, normal, metallic-roughness, emissive, BRDF LUT)

### 5. PBR Shading

The fragment shader implements the Cook-Torrance microfacet BRDF:

```
Lo = ∫ (kD × albedo/π + kS × DFG / (4·(N·V)·(N·L))) × Li × (N·L) dω
```

Where:
- **D** = GGX/Trowbridge-Reitz normal distribution
- **F** = Schlick Fresnel approximation
- **G** = Smith height-correlated visibility function

### 6. Image-Based Lighting (IBL)

For ambient/environment lighting:
- **Diffuse** — Irradiance cubemap (pre-convolved from environment map)
- **Specular** — Pre-filtered environment map + BRDF LUT (split-sum approximation)

```glsl
vec3 irradiance = texture(irradianceMap, N).rgb;
vec3 prefilteredSpec = textureLod(prefilterMap, R, roughness * maxMipLevel).rgb;
vec2 brdf = texture(brdfLUT, vec2(NdotV, roughness)).rg;
```

### 7. Shadow Mapping

Cascaded Shadow Maps split the view frustum into 4 cascades:

| Cascade | Near   | Far    | Map Size |
| ------- | ------ | ------ | -------- |
| 0       | 0.1    | 10     | 2048     |
| 1       | 10     | 50     | 2048     |
| 2       | 50     | 200    | 2048     |
| 3       | 200    | 1000   | 2048     |

Each cascade renders a depth-only pass from the light's perspective, then samples the shadow map in the main pass with PCF (2×2 kernel).

### 8. Tone Mapping & Gamma

HDR framebuffer → LDR output:

```glsl
// ACES tone mapping
vec3 mapped = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
// Gamma correction
fragColor = vec4(pow(mapped, vec3(1.0 / 2.2)), 1.0);
```

## Frame Graph

The frame graph manages render passes and their resource dependencies:

```
ShadowPass → GeometryPass → LightingPass → PostProcess → Screen
```

Passes are topologically sorted so resource producers always execute before consumers.

## Vertex Layout

Standard PBR mesh vertex:

| Attribute     | Location | Type    | Size     |
| ------------- | -------- | ------- | -------- |
| Position      | 0        | vec3    | 12 bytes |
| Normal        | 1        | vec3    | 12 bytes |
| Tangent       | 2        | vec4    | 16 bytes |
| UV0           | 3        | vec2    | 8 bytes  |
| Joint Indices | 4        | uvec4   | 16 bytes |
| Joint Weights | 5        | vec4    | 16 bytes |

Total: 80 bytes/vertex (without joints: 48 bytes/vertex).
