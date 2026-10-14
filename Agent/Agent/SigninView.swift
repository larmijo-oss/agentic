//
//  SignIn.swift
//  Agent
//
//  Created by Lena Armijo on 10/14/26.
//

import SwiftUI
import GoogleSignIn
import GoogleSignInSwift

struct SigninView: View {
    @Environment(AppViewModel.self) private var vm
    @Binding var isPresenting: Bool
    private let signinClient = GIDSignIn.sharedInstance
    @State private var isRefreshing = true
    
    private func getTicket(_ token: String) async {
        // call addAgent to obtain ticket from harnessd
        if let _ = await vm.rein.addAgent(token, errMsg: Bindable(vm).errMsg) {
            // save ticket to Keychain
            await Ticket.shared.save(errMsg: Bindable(vm).errMsg, showOk: Bindable(vm).showOk)
            if vm.errMsg.isEmpty {
                vm.showOk = true
                vm.errMsg = "Ticket refreshed."
            }
        } else {
            vm.errMsg = "harnessd cannot add user. Please try again."
        }
    }

    // body
    var body: some View {
            if let rootVC = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow?.rootViewController {
                VStack {
                    Spacer()
                    GoogleSignInButton {
                        Task {
                        if let token = await signinClient.signInAsync(withPresenting: rootVC) {
                            await getTicket(token)
                        } else {
                            vm.errMsg = "Failed Google Sign-In. Please try again."
                        }
                        isPresenting.toggle()
                        }
                    }
                    .frame(width:100, height:50, alignment: Alignment.center)
                    .opacity(isRefreshing ? 0 : 1) // hidden while refreshing
                    .overlay {
                        if isRefreshing {
                            VStack(spacing: 16) {
                                Text("Refreshing credentials...")
                                    .fixedSize()
                                Spacer()
                                ProgressView()
                                    .controlSize(.large)
                            }
                        }
                    }
                    // refresh or restore
                    .task {
                                        if let token = signinClient.currentUser?.idToken?.tokenString {
                                            await getTicket(token)
                                            isPresenting.toggle()
                                        } else if let token = await signinClient.restorePreviousSignInAsync() {
                                            await getTicket(token)
                                            isPresenting.toggle()
                                        } else {
                                            isRefreshing = false // show GoogleSignInButton and let user sign in
                                        }
                                    }
                    
                    Spacer()
                }
                // upon conclusion
                .onDisappear {
                                if let completion = vm.signinCompletion {
                                    vm.signinCompletion = nil
                                    Task {
                                        await completion()
                                    }
                                }
                            }
            }
        }
    
}

extension GIDSignIn {
    func signInAsync(withPresenting presenting: UIViewController) async -> String? {
        return await withUnsafeContinuation { cont in
            signIn(withPresenting: presenting) { result, error in
                if let result, let token = result.user.idToken?.tokenString  {
                    cont.resume(returning: token)
                } else {
                    print("Google SignIn error: \(String(describing: error?.localizedDescription))")
                    cont.resume(returning: nil)
                }
            }
        }
    }
    
    func restorePreviousSignInAsync() async -> String? {
        return await withUnsafeContinuation { cont in
            restorePreviousSignIn() { user, error in
                if let token = user?.idToken?.tokenString  {
                    cont.resume(returning: token)
                } else  {
                    print("Google Restore SignIn error: \(String(describing: error?.localizedDescription))")
                    cont.resume(returning: nil)
                }
            }
        }
    }
}
