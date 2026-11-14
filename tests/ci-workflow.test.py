import unittest,pathlib,yaml
ROOT=pathlib.Path(__file__).resolve().parents[1]
def workflow(name):return yaml.safe_load((ROOT/'.github/workflows'/name).read_text())
class WorkflowContract(unittest.TestCase):
 def test_private_guard_and_two_build_runners(self):
  w=workflow('ci.yml');build=workflow('verify.yml')
  self.assertEqual(set(w['jobs']),{'prepare_release','verify','verify_release','gate','publish'})
  self.assertEqual(set(build['jobs']),{'verify'})
  self.assertEqual(build.get('on',build.get(True)),{'workflow_call':{'inputs':{'release':{'type':'boolean','default':False},'release_id':{'type':'string','default':''}}}})
  self.assertEqual(build['jobs']['verify']['strategy']['matrix']['os'],['ubuntu-24.04','windows-2025'])
  for job in w['jobs'].values():self.assertIn('github.event.repository.private == false',job['if'])
  self.assertIn('github.event.repository.private == false',build['jobs']['verify']['if'])
 def test_one_required_gate_waits_for_matrix(self):
  w=workflow('ci.yml');gate=w['jobs']['gate']
  self.assertEqual(gate['needs'],['verify','verify_release']);self.assertIn('always()',gate['if'])
  self.assertIn('needs.verify.result',gate['steps'][0]['env']['VERIFY_RESULT'])
  self.assertIn('needs.verify_release.result',gate['steps'][0]['env']['RELEASE_RESULT'])
  self.assertEqual(w['jobs']['publish']['needs'],['prepare_release','verify_release','gate'])
 def test_browser_and_all_supported_codex_versions(self):
  s=(ROOT/'.github/workflows/verify.yml').read_text()
  self.assertIn('SUPPORTED_CODEX_VERSIONS',s)
  self.assertIn('ready_for_review',(ROOT/'.github/workflows/ci.yml').read_text())
  self.assertIn('node --test tests/ci-contract.test.mjs',s)
 def test_no_privileged_pr_or_cache(self):
  s=(ROOT/'.github/workflows/ci.yml').read_text();self.assertNotIn('pull_request_target',s)
  w=workflow('ci.yml');build=workflow('verify.yml');builder=build['jobs']['verify']
  self.assertEqual(w['jobs']['verify'].get('permissions',w['permissions']),{'contents':'read','actions':'read'})
  self.assertNotIn('permissions',build);self.assertNotIn('permissions',builder)
  for name,release in [('verify',False),('verify_release',True)]:
   self.assertEqual(w['jobs'][name]['uses'],'./.github/workflows/verify.yml')
   expected={'release':release}
   if release:expected['release_id']='${{ needs.prepare_release.outputs.release_id }}'
   self.assertEqual(w['jobs'][name]['with'],expected)
  self.assertEqual(w['jobs']['publish']['needs'],['prepare_release','verify_release','gate'])
  self.assertIn("github.ref == 'refs/heads/main'",w['jobs']['publish']['if'])
  build_source=(ROOT/'.github/workflows/verify.yml').read_text()
  self.assertNotIn('cache: npm',s+build_source)
  self.assertNotIn('upload-artifact@',s+build_source);self.assertNotIn('download-artifact@',s+build_source)
  self.assertNotIn('CI_STORAGE_APPROVAL',s+build_source)
  self.assertEqual(w['jobs']['prepare_release']['permissions'],{'contents':'write'})
  self.assertEqual(w['jobs']['verify_release']['needs'],['prepare_release'])
  self.assertEqual(w['jobs']['verify_release']['permissions'],{'contents':'write','actions':'read','id-token':'write','attestations':'write'})
  self.assertEqual(w['jobs']['publish']['permissions'],{'contents':'write','attestations':'read'})
  upload=next(step for step in builder['steps'] if step.get('run')=='node scripts/ci.mjs upload')
  self.assertEqual(upload['env']['RELEASE_ID'],'${{ inputs.release_id }}')
  self.assertIn('inputs.release',upload['if'])
 def test_full_native_goal_gate_uses_the_installed_contract_version(self):
  build=workflow('verify.yml');steps=build['jobs']['verify']['steps']
  ids=[step.get('id') for step in steps]
  native=next(step for step in steps if step.get('id')=='native_controls')
  self.assertLess(ids.index('fixture'),ids.index('native_controls'))
  self.assertEqual(native['if'],"env.FULL == 'true'")
  self.assertIn('RELE_NATIVE_GOALS_CLI=',native['run']);self.assertIn('RELE_NATIVE_GOALS_VERSION=',native['run'])
  self.assertIn('npm test -- tests/native-source-controls.test.ts',native['run'])
  self.assertIn('len(candidates)==1',native['run']);self.assertIn('.as_posix()',native['run'])
  contract=next(step for step in steps if step.get('name')=='Read the supported Codex contract')
  self.assertIn('SUPPORTED_CODEX_VERSIONS.at(-1)',contract['run']);self.assertIn('CODEX_GOALS_VERSION=',contract['run'])
  required=next(step for step in steps if step.get('name')=='Require every applicable check')['env']['REQUIRED']
  self.assertIn("env.FULL == 'true' && 'cleanup_diagnostics fixture native_controls",required)
if __name__=='__main__':unittest.main()
