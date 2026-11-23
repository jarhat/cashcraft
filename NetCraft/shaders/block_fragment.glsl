#ifdef GL_ES
precision mediump float;
precision mediump int;
#endif

uniform sampler2D sampler;
uniform sampler2D sky_sampler;
uniform float timer;
uniform float daylight;
uniform float flow_time;
uniform int ortho;

varying vec2 fragment_uv;
varying float fragment_ao;
varying float fragment_light;
varying float fog_factor;
varying float fog_height;
varying float diffuse;
varying vec3 flow_position;
varying float horizontal_face;

const float pi = 3.14159265;

void main() {
    vec2 sample_uv = fragment_uv;
    vec2 tile = floor(fragment_uv * 32.0);
    bool water = tile == vec2(13.0, 3.0);
    bool lava = tile == vec2(13.0, 1.0);
    bool flowing = flow_position.y < 0.0 && (water || lava);
    if (flowing) {
        float speed = water ? 0.8 : 0.25;
        float direction = flow_position.x < 36.0 ? 1.0 : -1.0;
        vec2 shift = horizontal_face > 0.5
            ? vec2(direction * flow_time * speed, 0.0)
            : vec2(0.0, -flow_time * speed);
        vec2 local = fract(fragment_uv * 32.0 - shift);
        sample_uv = (tile + mix(vec2(0.03125), vec2(0.96875), local)) / 32.0;
    }
    vec3 color = vec3(texture2D(sampler, sample_uv));
    if (color == vec3(1.0, 0.0, 1.0)) {
        discard;
    }
    bool cloud = color == vec3(1.0, 1.0, 1.0);
    if (cloud && bool(ortho)) {
        discard;
    }
    float df = cloud ? 1.0 - diffuse * 0.2 : diffuse;
    float ao = cloud ? 1.0 - (1.0 - fragment_ao) * 0.2 : fragment_ao;
    float glow = fragment_light + ((flowing && lava) ? 0.65 : 0.0);
    ao = min(1.0, ao + glow);
    df = min(1.0, df + glow);
    float value = min(1.0, daylight + glow);
    vec3 light_color = vec3(value * 0.3 + 0.2);
    vec3 ambient = vec3(value * 0.3 + 0.2);
    vec3 light = ambient + light_color * df;
    vec3 lit_color = color * light * ao;
    float luminance = dot(lit_color, vec3(0.2126, 0.7152, 0.0722));
    color = clamp(mix(vec3(luminance), lit_color, 1.08), vec3(0.0), vec3(1.0));
    vec3 sky_color = vec3(texture2D(sky_sampler, vec2(timer, fog_height)));
    color = mix(color, sky_color, fog_factor);
    gl_FragColor = vec4(color, 1.0);
}
