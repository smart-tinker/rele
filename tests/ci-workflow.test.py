import unittest,pathlib,yaml
ROOT=pathlib.Path(__file__).resolve().parents[1]
def workflow(name):return yaml.safe_load((ROOT/'.github/workflows'/name).read_text())
class WorkflowContract(unittest.TestCase):
 def test_private_guard_and_two_build_runners(self):
  w=workflow('ci.yml');build=workflow('verify.yml')
  self.assertEqual(set(w['jobs']),{'verify','verify_release','gate','publish'})
  self.assertEqual(set(build['jobs']),{'verify'})
  self.assertEqual(build.get('on',build.get(True)),{'workflow_call':{'inputs':{'release':{'type':'boolean','default':False}}}})
  self.assertEqual(build['jobs']['verify']['strategy']['matrix']['os'],['ubuntu-24.04','windows-2025'])
  for job in w['jobs'].values():self.assertIn('github.event.repository.private == false',job['if'])
  self.assertIn('github.event.repository.private == false',build['jobs']['verify']['if'])
 def test_one_required_gate_waits_for_matrix(self):
  w=workflow('ci.yml');gate=w['jobs']['gate']
  self.assertEqual(gate['needs'],['verify','verify_release']);self.assertIn('always()',gate['if'])
  self.assertIn('needs.verify.result',gate['steps'][0]['env']['VERIFY_RESULT'])
  self.assertIn('needs.verify_release.result',gate['steps'][0]['env']['RELEASE_RESULT'])
  self.assertEqual(w['jobs']['publish']['needs'],['verify_release','gate'])
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
   self.assertEqual(w['jobs'][name]['with'],{'release':release})
  self.assertEqual(w['jobs']['publish']['needs'],['verify_release','gate'])
  self.assertIn("github.ref == 'refs/heads/main'",w['jobs']['publish']['if'])
  build_source=(ROOT/'.github/workflows/verify.yml').read_text()
  self.assertIn('retention-days: 1',build_source);self.assertNotIn('cache: npm',s+build_source)
if __name__=='__main__':unittest.main()
