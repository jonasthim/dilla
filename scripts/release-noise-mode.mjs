// The DeepFilterNet enhancement ships in every release: the release build always bundles its model and glue
// ("beta" mode), whatever the tag. The tag argument is accepted for the workflow's call and does not change the result.
process.stdout.write('beta\n');
