// Enhancement is opt-in only on explicitly named beta releases. Other tags keep the ordinary build.
const tag=process.argv[2]??'';
process.stdout.write(/^v\d+\.\d+\.\d+-noise-beta\.\d+$/.test(tag)?'beta\n':'disabled\n');
