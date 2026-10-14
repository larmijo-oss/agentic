//
//  AgentApp.swift
//  Agent
//
//  Created by Lena Armijo on 9/4/26.
//

import SwiftUI

import Foundation

struct Exception: Error, LocalizedError {
    let errorDescription: String?
}

extension Optional where Wrapped == String {
    var nilIfEmpty: String? {
        guard let self, !self.isEmpty else { return nil }
        return self
    }
}

@Observable
final class AppViewModel {
    let rein = Rein()
        
    var message = "howdy?"
    let instruction = "Type a message…"

    var errMsg = ""
    var showOk = false
        
        var getSignedin: Bool = false
        @ObservationIgnored var signinCompletion: (() async -> Void)?
        
    var showError = false
    
    var conversation: [Chat] = []
}


@main
struct AgentApp: App {
    let vm = AppViewModel()
    
    init() {
            LocManager.shared.startUpdates()
            Ticket.shared.vm = vm
                Task { [vm] in
                    await Ticket.shared.open(errMsg: Bindable(vm).errMsg, showOk: Bindable(vm).showOk)
                }
        }
    
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                ContentView()
                    .environment(vm)
            }
        }
    }
}
