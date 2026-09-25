import ExpoModulesCore
import PassKit

struct PaymentSheetOptions: Record {
  @Field var requireBillingAddress: Bool = false
}

public final class ApplePayLabModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ApplePayLab")

    Function("canMakePayments") { () -> Bool in
      PKPaymentAuthorizationController.canMakePayments()
    }

    AsyncFunction("presentPaymentSheetAsync") { (options: PaymentSheetOptions?, promise: Promise) in
      ApplePaySheetController.shared.present(
        requireBillingAddress: options?.requireBillingAddress ?? false,
        promise: promise
      )
    }.runOnQueue(.main)
  }
}

private final class ApplePaySheetController: NSObject, PKPaymentAuthorizationControllerDelegate {
  static let shared = ApplePaySheetController()

  private var promise: Promise?
  private var controller: PKPaymentAuthorizationController?
  private var authorized = false
  private var billingPostalCode: String?

  func present(requireBillingAddress: Bool, promise: Promise) {
    guard self.promise == nil else {
      promise.reject(
        Exception(
          name: "SheetAlreadyPresented",
          description: "The Apple Pay sheet is already presented."
        )
      )
      return
    }

    let request = PKPaymentRequest()
    request.merchantIdentifier = "merchant.dev.e2e.benchmark"
    request.supportedNetworks = [.visa, .masterCard, .amex]
    request.merchantCapabilities = .threeDSecure
    request.countryCode = "US"
    request.currencyCode = "USD"
    if requireBillingAddress {
      request.requiredBillingContactFields = [.postalAddress]
    }
    request.paymentSummaryItems = [
      PKPaymentSummaryItem(label: "Trail Mix 500 g", amount: NSDecimalNumber(string: "6.99")),
      PKPaymentSummaryItem(label: "Rush delivery", amount: NSDecimalNumber(string: "2.00")),
      PKPaymentSummaryItem(label: "TA Benchmark", amount: NSDecimalNumber(string: "8.99")),
    ]

    let controller = PKPaymentAuthorizationController(paymentRequest: request)
    controller.delegate = self
    self.controller = controller
    self.authorized = false
    self.billingPostalCode = nil
    self.promise = promise

    controller.present { presented in
      if !presented {
        DispatchQueue.main.async {
          self.promise?.reject(
            Exception(
              name: "PresentationFailed",
              description:
                "The Apple Pay sheet could not be presented. Check the in-app-payments entitlement."
            )
          )
          self.cleanUp()
        }
      }
    }
  }

  func paymentAuthorizationController(
    _ controller: PKPaymentAuthorizationController,
    didAuthorizePayment payment: PKPayment,
    handler completion: @escaping (PKPaymentAuthorizationResult) -> Void
  ) {
    authorized = true
    billingPostalCode = payment.billingContact?.postalAddress?.postalCode
    completion(PKPaymentAuthorizationResult(status: .success, errors: nil))
  }

  func paymentAuthorizationControllerDidFinish(_ controller: PKPaymentAuthorizationController) {
    controller.dismiss {
      DispatchQueue.main.async {
        self.promise?.resolve([
          "status": self.authorized ? "authorized" : "dismissed",
          "billingPostalCode": self.billingPostalCode as Any,
        ])
        self.cleanUp()
      }
    }
  }

  private func cleanUp() {
    promise = nil
    controller = nil
    authorized = false
    billingPostalCode = nil
  }
}
