#ifdef GL_ES
precision mediump float;
#endif

varying vec3 pixel_color;

void main() {
    gl_FragColor = vec4(pixel_color, 1.0);
}
