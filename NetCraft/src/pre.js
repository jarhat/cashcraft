const args = unescape(document.location.hash).substring(1);
var argv = args === "" ? [] : args.split(/[ +]/);
if (argv.length === 0) argv = window.DEFAULT_ARGV || ['-'];
Module['arguments'] = argv;
