//
//  Ticket.swift
//  Agent
//
//  Created by Lena Armijo on 10/14/26.
//

import SwiftUI
import LocalAuthentication

final class Ticket {
    static let shared = Ticket() // create one instance of the class to be shared
    private init() {}            // and make the constructor private so no other
                                 // instances can be created: hence a **singleton**
    
    var vm: AppViewModel?

    // the ticket
    var creator = ""
    var expiration = Date(timeIntervalSince1970: 0.0)
    private var _ticket: String?
    var ticket: String? {
        get { Date() > expiration ? nil : _ticket }
        set(newValue) { _ticket = newValue }
    }
    
    func open(errMsg: Binding<String>, showOk: Binding<Bool>) async {
            if expiration != Date(timeIntervalSince1970: 0.0) {
                // not first launch
                return
            }
            
            // check if ticket exists
        // check for ticket in KeyChain
                var searchFor: [CFString: Any] = [
                    kSecClass: kSecClassGenericPassword,
                    kSecAttrDescription: "Ticket", // check existence only
                ]

                var searchStatus = SecItemCopyMatching(searchFor as CFDictionary, nil)
                if searchStatus == errSecItemNotFound {
                    errMsg.wrappedValue = "No previous Ticket found. Will acquire on sign in."
                    showOk.wrappedValue = true
                    return
                }

                let authContext = LAContext()

                // if simulator
                #if targetEnvironment(simulator)
                    guard let _ = try? await auth.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "to allow simulator to access KeyChain") else { errMsg.wrappedValue = "Open Keychain failed"; return }
                #endif
                
                // search for ticket
        // https://developer.apple.com/documentation/security/item-attribute-keys-and-values
               searchFor = [
                   kSecClass: kSecClassGenericPassword,
                   kSecAttrDescription: "Ticket",
                   kSecReturnData: true,
                   kSecReturnAttributes: true,
                   // Forces biometric authentication through the Secure Enclave hardware prompt
                   kSecUseAuthenticationContext: authContext
               ]

               var itemRef: AnyObject?
               searchStatus = SecItemCopyMatching(searchFor as CFDictionary, &itemRef)
               guard searchStatus == errSecSuccess else {
                   errMsg.wrappedValue = "Ticket.open search: \(String(describing: SecCopyErrorMessageString(searchStatus, nil) as String? ?? "authentication failed"))"
                   return
               }
           
               let df = DateFormatter()
               df.dateFormat="yyyy-MM-dd HH:mm:ss '+'SSSS"
           
               // ticket found
        if let item = itemRef as? NSDictionary,
                    let data = item[kSecValueData] as? Data,
                    let dateStr = item[kSecAttrLabel] as? String,
                    let ticketExp = df.date(from: dateStr),
                    let ticketCreator = item[kSecAttrCreator] as? String
                {
                    creator = ticketCreator
                    if Date() >= ticketExp {
                        errMsg.wrappedValue = "Ticket from last session expired. Will re-acquire on sign in."
                    } else {
                        errMsg.wrappedValue = "Ticket available from last session."
                        ticket = String(data: data, encoding: .utf8)
                        expiration = ticketExp
                    }
                    showOk.wrappedValue = true
                } else {
                    errMsg.wrappedValue = "Ticket found but invalid...deleting from KeyChain. Will re-acquire on sign in."
                    await delete(errMsg: errMsg)
                }


        }
    
    func save(errMsg: Binding<String>, showOk: Binding<Bool>) async {
            guard let ticketData = ticket?.data(using: .utf8) else {
                // no ticket to save.
                return
            }
            
            // check for ticket in KeyChain
            var item: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword,
                kSecAttrDescription: "Ticket", // Check existence only
            ]
            
            var opStatus = SecItemCopyMatching(item as CFDictionary, nil)
            
            let authContext = LAContext() // push core security enforcement to iOS kernel and secure enclave processor
            
            // if simulator
            #if targetEnvironment(simulator)
                guard let _ = try? await auth.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "to allow simulator to access KeyChain") else { errMsg.wrappedValue = "Save Keychain failed"; return }
            #endif
            
            let df = DateFormatter()
            df.dateFormat="yyyy-MM-dd HH:mm:ss '+'SSSS"
            let expStr = df.string(from: expiration)

            // save ticket
        if opStatus == errSecSuccess {
                    
                    item = [
                        kSecClass: kSecClassGenericPassword,
                        kSecAttrDescription: "Ticket",
                        // forces biometric authentication through the Secure Enclave hardware prompt
                        kSecUseAuthenticationContext: authContext
                    ]
                    
                    let updates: [CFString: Any] = [
                        kSecValueData: ticketData,
                        kSecAttrLabel: expStr,
                        kSecAttrCreator: creator
                    ]
                    
                    opStatus = SecItemUpdate(item as CFDictionary, updates as CFDictionary)
                    
                } else if opStatus == errSecItemNotFound {
                    let accessControl = SecAccessControlCreateWithFlags(
                        nil,
                        kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                        .userPresence,  // triggers biometric/pin check
                        nil)!
                    
                    item = [
                        kSecClass: kSecClassGenericPassword,
                        kSecAttrDescription: "Ticket",
                        kSecValueData: ticketData,          // ticket
                        kSecAttrLabel: expStr,
                        kSecAttrCreator: creator,
                        kSecAttrAccessControl: accessControl,  // requires biometric check
                        // forces biometric authentication through the Secure Enclave hardware prompt
                        kSecUseAuthenticationContext: authContext
                    ]
                    
                    opStatus = SecItemAdd(item as CFDictionary, nil)
                }


           if (opStatus == errSecSuccess) {
              errMsg.wrappedValue = "Ticket saved"
              showOk.wrappedValue = true
           } else {
              errMsg.wrappedValue = "\(String(describing: SecCopyErrorMessageString(opStatus, nil) as String? ?? "Ticket save failed"))\nYou can use ticket, but will be asked to sign in again when Agent relaunch."
           }
        }
    
    func delete(errMsg: Binding<String>) async {
            let item: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword,
                kSecAttrDescription: "Ticket",
            ]
            
            let delStatus = SecItemDelete(item as CFDictionary)
            if (delStatus != 0) {
                errMsg.wrappedValue += "\n\nTicket.delete: \(String(describing: SecCopyErrorMessageString(delStatus, nil)!))"
            } else {
                errMsg.wrappedValue += "Ticket: DELETED!))"
            }
        }
}
