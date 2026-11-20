#ifdef GL_ES
precision mediump float;
#endif

uniform mat4 matrix;
uniform vec2 origin;
uniform float size;
uniform float angle;
attribute vec2 position;
attribute vec3 color;
varying vec3 pixel_color;

void main() {
    vec2 pivot = vec2(0.9375, 0.0);
    vec2 p = position - pivot;
    float s = sin(angle);
    float c = cos(angle);
    vec2 rotated = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    gl_Position = matrix * vec4(origin + (rotated + pivot) * size, 0.0, 1.0);
    pixel_color = color;
}
