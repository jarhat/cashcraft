# ISO builds

Set `ISO_BUILD_API_URL` to the origin of the archuseriso API as seen by the
Python backend and `ISO_BUILD_API_KEY` to its bearer key. In Compose,
`host.docker.internal` refers to the Docker host; a builder in another container
must instead be reachable on a shared network. Keep the key server-side and use
HTTPS when the connection is not trusted.

The supplied build API starts the profiles already configured on the builder; it
does not specify per-request customization. Configure those profiles on the
builder before using Burn / ISO. The UI stops waiting after five minutes, but
this does not cancel the remote build.

The ISO endpoints are available to visitors of the application and can trigger
resource-intensive builds. Restrict access or apply authentication and rate
limits at the deployment proxy before enabling the build service.
