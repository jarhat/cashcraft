const args = document.location.hash.substring(1);
var argv = args === "" ? [] : args.split(/[ +]/).map(decodeURIComponent);
if (argv.length === 0) argv = window.DEFAULT_ARGV || ['-'];
Module['arguments'] = argv;
