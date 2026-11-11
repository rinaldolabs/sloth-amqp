# Changelog

## [0.2.0](https://github.com/rinaldolabs/sloth-amqp/compare/v0.1.0...v0.2.0) (2026-11-11)


### ⚠ BREAKING CHANGES

* errors thrown by this package are now SlothError subclasses rather than plain Error. Message text is unchanged; code matching on error.message still works, but error.constructor changes.
* **deps:** consumers must now provide amqplib ^2.0.0 as a peer dependency. amqplib ^1.x is no longer supported.
* **api:** slothDelaySender removed in favour of createDelaySender; resolveDelayUnixSeconds removed in favour of resolveDelaySeconds. Migration is mechanical: replace slothDelaySender(client) with createDelaySender(client).send, and rename the helper import.
* dist layout changes from a single index.js to a dual ESM and CJS layout. Anyone deep-importing internal dist/ paths will need to update. Public exports-based consumers are unaffected.
* **sender:** a broker-rejected publish now throws where it previously appeared to succeed. Public API surface is unchanged.

### Features

* accept AbortSignal and timeoutMs on slothConnect and setupDelayedMessageListener ([#11](https://github.com/rinaldolabs/sloth-amqp/issues/11)) ([dd97dce](https://github.com/rinaldolabs/sloth-amqp/commit/dd97dce92561e5b25ab6cc0b270bc76bcdd352ad))
* **api:** add ping health-check helper ([ca116df](https://github.com/rinaldolabs/sloth-amqp/commit/ca116df93d13b8843ba3a69e53f630bf54f7bf06))
* **api:** rename slothDelaySender to createDelaySender returning DelaySender object ([#10](https://github.com/rinaldolabs/sloth-amqp/issues/10)) ([f2aff02](https://github.com/rinaldolabs/sloth-amqp/commit/f2aff02ebcd897364a679669364c0cd19114c1ae))
* **connection:** optional connection_name client property ([665fcc3](https://github.com/rinaldolabs/sloth-amqp/commit/665fcc3b52817bedb572cc492261cca6f406758c))
* dual-publish ESM+CJS, broaden logger compatibility ([#9](https://github.com/rinaldolabs/sloth-amqp/issues/9)) ([3de24b4](https://github.com/rinaldolabs/sloth-amqp/commit/3de24b4314177494a0a05273e377b275858ee7c2))
* harden runtime, error contract, and release pipeline ([fb5d8a5](https://github.com/rinaldolabs/sloth-amqp/commit/fb5d8a586a1ed9b50390637095ac5004c4ec1e22))
* harden runtime, error contract, and release pipeline ([b6fe062](https://github.com/rinaldolabs/sloth-amqp/commit/b6fe062890cebf1d66d04c4a1501cc98e14a0646))
* **listener:** add optional consumer prefetch with a safe default ([619fb9d](https://github.com/rinaldolabs/sloth-amqp/commit/619fb9d353d719d5586cdbc168cb8c955fc9ce09))
* **listener:** drain in-flight handlers on close() ([fd4ab6a](https://github.com/rinaldolabs/sloth-amqp/commit/fd4ab6a88e4e54a8ad31c45f4f506ee745db8cb8))
* **listener:** make SlothListenerHandle an AsyncDisposable ([34db2e2](https://github.com/rinaldolabs/sloth-amqp/commit/34db2e224aaed7f0048a15d63c77852036711ee2))
* **listener:** nack and log structurally-unusable deliveries ([418a12e](https://github.com/rinaldolabs/sloth-amqp/commit/418a12eca72d4e356902dfdca4233b2434e0e717))
* **listener:** object-first event-named log calls ([7ebe97a](https://github.com/rinaldolabs/sloth-amqp/commit/7ebe97a8812ddd763d45e903a3fc9a15b7c0f281))
* opt-in wire-message tap ([14a81f6](https://github.com/rinaldolabs/sloth-amqp/commit/14a81f646b107f87cef32895f33c896d844b022d))
* **sender:** auto messageId, correlationId, and trace-header passthrough ([3a3d51d](https://github.com/rinaldolabs/sloth-amqp/commit/3a3d51d29b026d6ebbe56905278580f54164338e))
* **sender:** cached confirm channel + widen amqplib peer dep ([#8](https://github.com/rinaldolabs/sloth-amqp/issues/8)) ([6ae83d7](https://github.com/rinaldolabs/sloth-amqp/commit/6ae83d7f3c9065a283e3370dbdd592e733c3a35e))
* **sender:** delaySeconds / delayUntil variants + input hardening ([#5](https://github.com/rinaldolabs/sloth-amqp/issues/5)) ([7226c01](https://github.com/rinaldolabs/sloth-amqp/commit/7226c0113c3cf66d0c39fb895ecf1da9edada529))
* **sender:** optional publish timeout / AbortSignal ([4115946](https://github.com/rinaldolabs/sloth-amqp/commit/4115946d93634cbd7408bb811a92fef7041d804e))
* test RabbitMQ 3.13 to 4.4, mandatory publish, opt-in quorum ([#441](https://github.com/rinaldolabs/sloth-amqp/issues/441)) ([68be3f7](https://github.com/rinaldolabs/sloth-amqp/commit/68be3f79dc61e4f128baf694270ffc24bb7810d6))
* typed error hierarchy ([c8ff05b](https://github.com/rinaldolabs/sloth-amqp/commit/c8ff05b5d42b0958240b312a87f47d101fc4a3c9))


### Bug Fixes

* **build:** declare @types/node and pin Node lib/types ([54476f0](https://github.com/rinaldolabs/sloth-amqp/commit/54476f0a26c67b44f0d0d85e4e33999bb4414ff0))
* **build:** widen engines floor to &gt;=22, drop npm pin ([a99dd90](https://github.com/rinaldolabs/sloth-amqp/commit/a99dd90caeff85bd5d7d44ac25ea5e5d2e23cd93))
* **connection:** run setups sequentially in argument order ([3ef26ba](https://github.com/rinaldolabs/sloth-amqp/commit/3ef26ba224e0183e3d290236912a150f712fbb5f))
* **listener:** guard ack/nack against synchronous IllegalOperationError ([710e932](https://github.com/rinaldolabs/sloth-amqp/commit/710e932dce36d6bf0c66459174f50dff111cce4a))
* **listener:** route channel-error logs through errMessage ([00b0dcb](https://github.com/rinaldolabs/sloth-amqp/commit/00b0dcb82c7f1c00fca902df50d43fe05c627b38))
* **wire:** validate onWireMessage is a function; doc provenance check ([a156533](https://github.com/rinaldolabs/sloth-amqp/commit/a156533f3301d0424114ccf53bb4de7189e5c8a1))


### Miscellaneous Chores

* **deps:** ncu dependency sweep (incl. amqplib v2) ([#251](https://github.com/rinaldolabs/sloth-amqp/issues/251)) ([d52c666](https://github.com/rinaldolabs/sloth-amqp/commit/d52c6663c6f65d2ef591b0991ff229e7eb76de52))

## Changelog
