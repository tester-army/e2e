Pod::Spec.new do |s|
  s.name           = 'ApplePayLab'
  s.version        = '1.0.0'
  s.summary        = 'Apple Pay payment-sheet fixture for the e2e mobile benchmark'
  s.description    = s.summary
  s.license        = { :type => 'MIT' }
  s.author         = { 'e2e' => 'oskar@tester.army' }
  s.homepage       = 'https://github.com/tester-army/e2e'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/tester-army/e2e' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'PassKit', 'UIKit'
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
