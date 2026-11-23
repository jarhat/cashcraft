#ifdef GL_ES
precision highp float;
precision mediump int;
#endif

uniform mat4 matrix;
uniform vec3 camera;
uniform float fog_distance;
uniform int ortho;
uniform vec2 cloud_offset;

attribute vec4 position;
attribute vec3 normal;
attribute vec4 uv;

varying vec2 fragment_uv;
varying float fragment_ao;
varying float fragment_light;
varying float fog_factor;
varying float fog_height;
varying float diffuse;
varying vec3 flow_position;
varying float horizontal_face;

const float pi = 3.14159265;
vec3 light_direction = normalize(vec3(-1.0, 1.0, -1.0));

void main() {
    vec4 world_position = position;
    // Cloud atlas tile, shared by all six faces.
    if (floor(uv.xy * 32.0) == vec2(10.0, 0.0)) {
        world_position.xz += cloud_offset;
    }
    gl_Position = matrix * world_position;
    fragment_uv = uv.xy;
    flow_position = vec3(mod(position.x, 64.0), position.y, position.z);
    horizontal_face = abs(normal.y);
    fragment_ao = 0.3 + (1.0 - uv.z) * 0.7;
    fragment_light = uv.w;
    diffuse = max(0.0, dot(normal, light_direction));
    if (bool(ortho)) {
        fog_factor = 0.0;
        fog_height = 0.0;
    }
    else {
        float camera_distance = distance(camera, world_position.xyz);
        float fog = clamp(camera_distance / fog_distance, 0.0, 1.0);
        fog_factor = fog * fog * fog * fog;
        float dy = world_position.y - camera.y;
        float dx = distance(world_position.xz, camera.xz);
        fog_height = (atan(dy, dx) + pi / 2.0) / pi;
    }
}
